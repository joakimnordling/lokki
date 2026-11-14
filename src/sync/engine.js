/* One sync round with one server (docs/sync-protocol.md, section 7), independent of where the device keeps its data.

   The device is an adapter (see memory.js for the reference one):
     keyring() / setKeyring(k)       the vault keyring this device holds
     get(kind, id)                   the local record, in the protocol's shape, or null
     apply(records, bit)             store pulled records that won; only `bit` set on them
     markHas(kind, id, bit)          the server has the current version
     markLacks(kind, id, bit)        it doesn't: push it there
     pending(bit)                    local records the server lacks (never live entries of deleted metrics)
     clearBit(bit)                   forget what this server has (a different or restored server), and its unreadable bits
     unreadable(key)                 bits of the servers holding row `key` in a format this device can't read: a
     markUnreadable(key, bit)          newer app's. Kept per row name, not per record, since this device may not have
     clearUnreadable(key, bit)         the record yet. Nothing is pushed to a server over such a row (section 7.5).
     all()                           every local record
   The server state is a plain object the caller keeps: {url, token, id, bit, cursor, mark, keyringVersion,
   pulledUsingRowFormat}.
   `pulledUsingRowFormat` is the newest row format this device's code could decrypt and parse when it last pulled
   from the server (section 7.5).
   `mark` is the mark of the push that wrote row number `cursor` (section 7.4). */
import {
  APP,
  DamagedRowError,
  decryptRow,
  encryptRow,
  FormatError,
  READABLE_ROW_FORMAT,
  rowKey,
  verifyKeyring,
} from "./crypto.js";
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
 * Returns a report: {pulled, applied, pushed, unknownFormat, held, damaged, repaired, keyring}. `held`: records
 * waiting for an update, because this server has their rows in a format this device can't read.
 * Throws ServerError (e.g. status 0 when offline, 401 for a revoked token), DifferentVaultError and OtherAppError.
 * `rowFormat`: the newest row format this code can decrypt and parse; only tests set it, to act as an updated app.
 */
export async function syncRound({ server, device, keys, http, rowFormat = READABLE_ROW_FORMAT }) {
  const report = {
    pulled: 0,
    applied: 0,
    pushed: 0,
    unknownFormat: 0,
    held: 0,
    damaged: [],
    repaired: 0,
    keyring: "same",
  };
  const info = await http.info();
  if (server.id && server.id !== info.id) forget(server, device); // a different server at this URL
  server.id = info.id;

  // This code can decrypt and parse a newer row format than when it last pulled from here: pull everything again, so
  // the rows it skipped are merged now (section 7.5). A server without the field was last pulled by code that could
  // decrypt and parse this format.
  if ((server.pulledUsingRowFormat ?? rowFormat) < rowFormat) forget(server, device);
  server.pulledUsingRowFormat = rowFormat;

  let vault = await http.vault();
  if (vault.head < server.cursor) forget(server, device); // restored from an older state (section 7.4)
  vault = await syncKeyring({ server, device, keys, http, vault, report });

  let { head, mark } = await pullAll({ server, device, keys, http, report });
  await repair({ server, device, keys, report });
  for (let conflicts = 0; ; ) {
    const pending = device.pending(server.bit);
    if (!pending.length) break;
    const batch = await encryptBatch({ keys, pending, limits: info.limits, device, bit: server.bit });
    report.held = batch.held;
    if (!batch.rows.length) break; // all that's left waits for an update that reads this server's newer rows
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
export async function syncAll({ device, keys, links, maxPasses = 3, rowFormat = READABLE_ROW_FORMAT }) {
  let results = [];
  for (let pass = 0; pass < maxPasses; pass++) {
    results = [];
    let applied = 0;
    for (const { server, http } of links) {
      try {
        const report = await syncRound({ server, device, keys, http, rowFormat });
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
  let since = server.cursor;
  let mark = server.mark ?? null;
  let start; // the vault's head and its mark when this device started pulling without marks
  for (;;) {
    // The server checks every page (section 7.4): that the push with `mark` wrote the last row this device has; or,
    // while its pages come without marks, as when pulling everything, that nothing changed up to the head it started at
    if (!(since && mark) && start === undefined) {
      const vault = await http.vault();
      start = vault.head && vault.mark ? { at: vault.head, mark: vault.mark } : null;
    }
    let page;
    try {
      page = await http.pull(since, since && mark ? { mark } : (start ?? {}));
    } catch (e) {
      if (!(e instanceof ServerError && e.code === "history_changed")) throw e;
      // Not the history this device pulled from, or the server doesn't remember it: start over
      forget(server, device);
      [since, mark, start] = [0, null, undefined];
      continue;
    }
    const winners = [];
    for (const row of page.rows) {
      report.pulled++;
      let record;
      try {
        record = await decryptRow(keys, row.key, row.data);
      } catch (e) {
        if (e instanceof FormatError) {
          // A newer app's version: never push over it from here (section 7.5)
          report.unknownFormat++;
          device.markUnreadable(row.key, server.bit);
        } else if (e instanceof DamagedRowError) {
          report.damaged.push(row.key);
          device.clearUnreadable(row.key, server.bit); // not a newer version: repairing it is fine
        } else throw e;
        continue;
      }
      device.clearUnreadable(row.key, server.bit); // this server's row is one this device reads now
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

// The next batch for a server: up to `limits.push` rows, leaving out records whose row there is one this device
// can't read (`held`, counted) and records too large for the server (they stay pending, and are reported once
// nothing else is left). Held records are skipped before the batch is cut, so they never take the place of others.
async function encryptBatch({ keys, pending, limits, device, bit }) {
  const rows = [];
  const records = [];
  let held = 0,
    large = 0;
  for (const record of pending) {
    if (rows.length >= limits.push) break;
    // checked by name before encrypting: held records stay pending, so every batch passes them again
    if (device.unreadable(await rowKey(keys, record.kind, record.id)) & (1 << bit)) {
      held++;
      continue;
    }
    const row = await encryptRow(keys, record);
    if (row.data.length > limits.row_bytes) {
      large++;
      continue;
    }
    rows.push(row);
    records.push(record);
  }
  if (!rows.length && large)
    throw new ServerError(413, { error: "too_large", message: "A record is too large for this server." });
  return { rows, records, held };
}
