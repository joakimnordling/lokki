/* One sync round with one server (docs/sync-protocol.md, section 7), independent of where the device keeps its data.

   The device is an adapter (see memory.js for the reference one):
     keyring() / setKeyring(k)       the vault keyring this device holds
     get(kind, id)                   the local record, in the protocol's shape, or null
     apply(records, bit)             store pulled records that won; only `bit` set on them
     markHas(kind, id, bit)          the server has the current version
     markLacks(kind, id, bit)        it doesn't: push it there
     pending(bit)                    local records the server lacks (never live entries of deleted metrics)
     clearBit(bit)                   forget what this server has (a different or restored server)
     all()                           every local record
   The server state is a plain object the caller keeps: {url, token, id, bit, cursor, mark, keyringVersion}.
   `mark` is the mark of the push that wrote row number `cursor` (section 7.4). */
import { APP, DamagedRowError, decryptRow, encryptRow, FormatError, rowKey, verifyKeyring } from "./crypto.js";
import { ServerError } from "./http.js";
import { compareRecords } from "./merge.js";

const MAX_CONFLICTS = 5; // pushes refused because another device pushed first, per round
const MAX_REPAIRS = 200; // damaged rows replaced from this device's copy, per round

/** The server holds a different vault: stop syncing with it (it's not ours to change). */
export class DifferentVaultError extends Error {}
/** The server's vault is for another app using the same protocol (protocol 4.4). */
export class OtherAppError extends Error {}

/**
 * Pull everything new from a server, merge it, and push what it lacks.
 * Returns a report: {pulled, applied, pushed, unknownFormat, damaged, repaired, keyring}.
 * Throws ServerError (e.g. status 0 when offline, 401 for a revoked token), DifferentVaultError and OtherAppError.
 */
export async function syncRound({ server, device, keys, http }) {
  const report = { pulled: 0, applied: 0, pushed: 0, unknownFormat: 0, damaged: [], repaired: 0, keyring: "same" };
  const info = await http.info();
  if (server.id && server.id !== info.id) forget(server, device); // a different server at this URL
  server.id = info.id;

  let vault = await http.vault();
  if (vault.head < server.cursor) forget(server, device); // restored from an older state (section 7.4)
  vault = await syncKeyring({ server, device, keys, http, vault, report });

  let { head, mark } = await pullAll({ server, device, keys, http, report });
  await repair({ server, device, keys, report });
  for (let conflicts = 0; ; ) {
    const pending = device.pending(server.bit);
    if (!pending.length) break;
    const batch = await encryptBatch(keys, pending, info.limits);
    try {
      ({ head, mark } = await http.push(head, mark, batch.rows));
    } catch (e) {
      if (!(e instanceof ServerError && e.status === 409) || ++conflicts > MAX_CONFLICTS) throw e;
      ({ head, mark } = await pullAll({ server, device, keys, http, report }));
      continue;
    }
    for (const r of batch.records) device.markHas(r.kind, r.id, server.bit);
    server.cursor = head;
    server.mark = mark;
    report.pushed += batch.records.length;
  }
  return report;
}

/**
 * Sync rounds with every server of a device: `links` is [{server, http}]. A change pulled from one server is pushed
 * to the others in the same call: after a pass that brought something new, the servers that came before it get
 * another round. Returns [{server, report}] or [{server, error}] for each server, from the last pass.
 */
export async function syncAll({ device, keys, links, maxPasses = 3 }) {
  let results = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    results = [];
    let applied = 0;
    for (const { server, http } of links) {
      try {
        const report = await syncRound({ server, device, keys, http });
        applied += report.applied;
        results.push({ server, report });
      } catch (error) {
        results.push({ server, error });
      }
    }
    if (!applied || links.length < 2) break;
  }
  return results;
}

function forget(server, device) {
  device.clearBit(server.bit);
  server.cursor = 0;
  server.mark = null;
  server.keyringVersion = 0;
}

async function syncKeyring({ server, device, keys, http, vault, report }) {
  for (let tries = 0; tries < MAX_CONFLICTS; tries++) {
    const mine = device.keyring();
    let theirs = vault.keyring;
    if (theirs && theirs.app !== APP) throw new OtherAppError(`this server's vault is for another app (${theirs.app})`);
    if (theirs && mine && theirs.vault !== mine.vault)
      throw new DifferentVaultError("this server holds a different vault");
    if (theirs && !(await verifyKeyring(keys, theirs))) {
      report.keyring = "damaged"; // replaced with ours below
      theirs = null;
    }
    server.keyringVersion = vault.keyring_version;
    if (theirs && (!mine || theirs.u > mine.u)) {
      device.setKeyring(theirs);
      report.keyring = "updated";
      return vault;
    }
    if (!mine || (theirs && theirs.u === mine.u)) return vault;
    try {
      server.keyringVersion = (await http.putKeyring(vault.keyring_version, mine)).keyring_version;
      if (report.keyring === "same") report.keyring = "sent";
      return vault;
    } catch (e) {
      if (e instanceof ServerError && e.code === "different_vault") throw new DifferentVaultError(e.message);
      if (!(e instanceof ServerError && e.status === 409)) throw e;
      vault = await http.vault();
    }
  }
  return vault;
}

async function pullAll({ server, device, keys, http, report }) {
  for (let since = server.cursor, mark = server.mark ?? null; ; ) {
    let page;
    try {
      // Every page says which push wrote the last row this device has; the server checks it (section 7.4)
      page = await http.pull(since, since ? mark : null);
    } catch (e) {
      if (!(e instanceof ServerError && e.code === "history_changed")) throw e;
      // Not the history this device pulled from, or the server doesn't remember it: start over
      forget(server, device);
      [since, mark] = [0, null];
      continue;
    }
    const winners = [];
    for (const row of page.rows) {
      report.pulled++;
      let record;
      try {
        record = await decryptRow(keys, row.key, row.data);
      } catch (e) {
        if (e instanceof FormatError) report.unknownFormat++;
        else if (e instanceof DamagedRowError) report.damaged.push(row.key);
        else throw e;
        continue;
      }
      const local = device.get(record.kind, record.id);
      const order = local ? compareRecords(record, local) : 1;
      if (order > 0) winners.push(record);
      else if (order === 0) device.markHas(record.kind, record.id, server.bit);
      else device.markLacks(record.kind, record.id, server.bit);
    }
    if (winners.length) {
      await device.apply(winners, server.bit);
      report.applied += winners.length;
    }
    [since, mark] = [page.cursor, page.mark ?? null];
    // Kept only with a mark: a cursor the server can't vouch for later would mean starting over
    if (page.mark || !page.cursor) {
      server.cursor = page.cursor;
      server.mark = page.mark ?? null;
    }
    if (!page.more) return { head: page.head, mark: page.mark ?? null };
  }
}

// Damaged rows whose key belongs to a local record get this device's copy pushed over them (section 7.5).
async function repair({ server, device, keys, report }) {
  if (!report.damaged.length) return;
  const wanted = new Set(report.damaged.slice(0, MAX_REPAIRS));
  for (const record of device.all()) {
    if (!wanted.size) break;
    const key = await rowKey(keys, record.kind, record.id);
    if (wanted.delete(key)) {
      device.markLacks(record.kind, record.id, server.bit);
      report.repaired++;
    }
  }
}

async function encryptBatch(keys, pending, limits) {
  const rows = [];
  const records = [];
  for (const record of pending.slice(0, limits.push)) {
    const row = await encryptRow(keys, record);
    if (row.data.length > limits.row_bytes) continue; // too large for this server: stays pending, reported by the caller
    rows.push(row);
    records.push(record);
  }
  if (!rows.length)
    throw new ServerError(413, { error: "too_large", message: "A record is too large for this server." });
  return { rows, records };
}
