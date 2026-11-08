// The Sync sheets (standalone only): set up with a first server and a passphrase, servers and their status, passphrase.
import { ago, esc } from "../core/format.js";
import { DamagedKeyringError, WrongPassphraseError } from "../sync/crypto.js";
import { ServerError } from "../sync/http.js";
import { hostOf, sync } from "../sync/manager.js";
import { $ } from "./dom.js";
import { ICON } from "./icons.js";
import { sheet, toast } from "./sheets.js";

const MIN_PASSPHRASE = 12;

export function openSync() {
  if (sync.vault) overview();
  else connect();
}

/** A one-line summary for the Preferences row. */
export function syncSummary() {
  const st = sync.status();
  if (!st.setUp) return "Off. Keep your logs on several devices through a server you choose, end-to-end encrypted.";
  if (!st.servers.length) return "No servers. Add one to sync.";
  if (st.failing) return "A server has a problem. Tap to see.";
  if (st.unsynced) return `${st.unsynced === 1 ? "1 change" : `${st.unsynced} changes`} waiting to sync.`;
  return `On, with ${st.servers.length === 1 ? "1 server" : `${st.servers.length} servers`}. End-to-end encrypted.`;
}

const field = (id, label, attrs = "") =>
  `<div class="field"><label for="${id}">${label}</label><input id="${id}" class="wide" autocapitalize="off" spellcheck="false" ${/autocomplete=/.test(attrs) ? "" : 'autocomplete="off"'} ${attrs}></div>`;
// Passphrase fields sit in a form with a fixed user name, so password managers offer to save and fill the passphrase.
const passphraseForm = (fields) =>
  `<form onsubmit="return false"><input type="text" name="username" value="Lokki vault" autocomplete="username" hidden>${fields}</form>`;
const NEW = 'type="password" autocomplete="new-password"';
const CURRENT = 'type="password" autocomplete="current-password"';
const serverFields = (url = "") =>
  field("sUrl", "URL", `type="url" inputmode="url" placeholder="https://sync.example.com" value="${esc(url)}"`) +
  field("sToken", "Token", `type="password" placeholder="lk_…"`);

function explain(e) {
  if (e instanceof ServerError) {
    if (e.status === 0) return "Can't reach the server. Check the URL and your connection.";
    if (e.status === 401) return "The server doesn't accept this token.";
    if (e.status === 403) return "This token can only read. Sync needs a token that can write.";
    return `The server answered: ${e.message}`;
  }
  return e?.message || "Something went wrong.";
}

/** Run an async step from a sheet's Done button: shows progress and errors in the sheet, closes it when done. */
function busy(label, work) {
  return () => {
    const button = $("#sDone");
    const was = button.textContent;
    button.disabled = true;
    button.textContent = label;
    $(".sheet .err").textContent = "";
    work()
      .then((close) => close?.())
      .catch((e) => {
        $(".sheet .err").textContent = e.userMessage || explain(e);
      })
      .finally(() => {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = was;
        }
      });
    return false;
  };
}
const fail = (userMessage) => Object.assign(new Error(userMessage), { userMessage });

function readServer() {
  let url = $("#sUrl").value.trim();
  const token = $("#sToken").value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    new URL(url);
  } catch {
    throw fail("Enter the server's URL, for example https://sync.example.com.");
  }
  if (!token) throw fail("Enter the token the server gave you.");
  return { url, token };
}

// ---- setting up

function connect() {
  sheet(
    "Set Up Sync",
    `<p class="lead">Sync keeps your logs on several devices through a server you choose. Everything is encrypted on this device with a passphrase only you know; the server can't read it.</p>
    ${serverFields()}<p class="preview">The server's operator gives you the URL and a token.</p><div class="err"></div>`,
    {
      doneLabel: "Next",
      done: busy("Connecting…", async () => {
        const { url, token } = readServer();
        const { keyring } = await sync.inspect(url, token);
        if (keyring) unlockVault(url, token, keyring);
        else choosePassphrase(url, token);
      }),
    },
  );
  $("#sUrl").focus();
}

function strength(p) {
  if (!p) return "";
  if (p.length < MIN_PASSPHRASE) return `Too short: at least ${MIN_PASSPHRASE} characters.`;
  if (p.length < 16) return "OK. Longer is stronger: a few unrelated words work well.";
  if (p.length < 24) return "Good.";
  return "Strong.";
}

function choosePassphrase(url, token) {
  sheet(
    "Choose a Passphrase",
    `<p class="lead">The passphrase encrypts your logs before they leave this device. Keep it somewhere safe, such as a password manager: if you forget it, nobody can open the data on servers. Devices already set up keep working.</p>
    ${passphraseForm(field("p1", "Passphrase", NEW) + field("p2", "Again", NEW))}<div class="strength" id="pStrength"></div><div class="err"></div>`,
    {
      doneLabel: "Turn On",
      done: busy("Encrypting…", async () => {
        const p = $("#p1").value;
        if (p.length < MIN_PASSPHRASE) throw fail(`Use at least ${MIN_PASSPHRASE} characters.`);
        if (p !== $("#p2").value) throw fail("The two passphrases differ.");
        await sync.createVault(p);
        await sync.addServer(url, token);
        toast("Sync is on");
        return overview;
      }),
    },
  );
  $("#p1").oninput = () => {
    $("#pStrength").textContent = strength($("#p1").value);
  };
  $("#p1").focus();
}

function unlockVault(url, token, keyring) {
  sheet(
    "Enter Your Passphrase",
    `<p class="lead">This server already holds your logs. Enter the passphrase you chose when you set up sync. Logs already on this device are added to them.</p>
    ${passphraseForm(field("p1", "Passphrase", CURRENT))}<div class="err"></div>`,
    {
      doneLabel: "Unlock",
      done: busy("Unlocking…", async () => {
        try {
          await sync.joinVault(keyring, $("#p1").value);
        } catch (e) {
          if (e instanceof WrongPassphraseError) throw fail("That's not the passphrase.");
          if (e instanceof DamagedKeyringError)
            throw fail("This server's keyring has been changed by someone without your passphrase.");
          throw e;
        }
        await sync.addServer(url, token);
        toast("Sync is on");
        return overview;
      }),
    },
  );
  $("#p1").focus();
}

// ---- the overview

function serverState(s, running) {
  if (running) return [ICON.syncing, "Syncing…", false];
  if (!s.last) return [ICON.sending, "Not synced yet", false];
  if (!s.last.ok) return [s.last.error?.startsWith("Can't reach") ? ICON.offline : ICON.failing, s.last.error, true];
  if (s.lacks) return [ICON.sending, `${s.lacks === 1 ? "1 change" : `${s.lacks} changes`} to send`, false];
  return [ICON.synced, `Up to date · synced ${ago(s.last.at).toLowerCase()}`, false];
}

function overviewBody() {
  const st = sync.status();
  const rows = st.servers
    .map((s) => {
      const [icon, text, bad] = serverState(s, st.running);
      return `<button class="setrow" data-server="${s.bit}"><span class="srv"><span class="${bad ? "bad" : ""}">${icon}</span><span>${esc(s.name)}<small class="${bad ? "bad" : ""}">${esc(text)}</small></span></span><span>›</span></button>`;
    })
    .join("");
  const summary = st.unsynced
    ? `${st.unsynced === 1 ? "1 change" : `${st.unsynced} changes`} on this device haven't reached any server yet.`
    : st.servers.length
      ? "Everything on this device has reached at least one server."
      : "Add a server to sync.";
  return `${rows}
    <button class="setrow" id="yAdd"><span>Add Server<small>Another copy, on another server. Each one gets everything.</small></span><span>›</span></button>
    <button class="setrow" id="yNow"><span>Sync Now</span><span>›</span></button>
    <button class="setrow" id="yPass"><span>Change Passphrase<small>Other devices keep working; new ones need the new passphrase.</small></span><span>›</span></button>
    <div class="preview" style="padding-top:14px">${esc(summary)} End-to-end encrypted: servers can't read your logs.</div>`;
}

function overview() {
  const close = sheet("Sync", `<div id="syncBody">${overviewBody()}</div>`, { cancel: "Done" });
  const bind = () => {
    for (const b of document.querySelectorAll("[data-server]")) b.onclick = () => serverSheet(+b.dataset.server);
    $("#yAdd").onclick = addServer;
    $("#yNow").onclick = () => sync.now();
    $("#yPass").onclick = changePassphrase;
  };
  bind();
  const off = sync.onChange(() => {
    const body = $("#syncBody");
    if (!body) return off();
    body.innerHTML = overviewBody();
    bind();
  });
  return close;
}

function serverSheet(bit) {
  const s = sync.status().servers.find((x) => x.bit === bit);
  const report = s.last?.report;
  const detail = s.last
    ? `Last sync ${ago(s.last.at).toLowerCase()}${report ? `: ${report.applied} received, ${report.pushed} sent` : ""}.${report?.damaged ? ` ${report.damaged} damaged rows found${report.repaired ? `, ${report.repaired} repaired from this device` : ""}.` : ""}${report?.unknownFormat ? ` ${report.unknownFormat} rows from a newer Lokki: update the app to read them.` : ""}`
    : "Not synced yet.";
  sheet(
    s.name,
    `${field("sUrl", "URL", `type="url" value="${esc(s.url)}"`)}${field("sToken", "Token", 'type="password" placeholder="unchanged"')}
    <p class="preview">${esc(detail)} A new URL for the same server continues where it left off.</p><div class="err"></div>
    <button class="plain" id="sRemove">Stop Syncing With This Server</button>
    <button class="danger" id="sDelete">Delete Everything on This Server</button>`,
    {
      doneLabel: "Save",
      done: busy("Saving…", async () => {
        let url = $("#sUrl").value.trim();
        if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
        try {
          new URL(url);
        } catch {
          throw fail("Enter the server's URL.");
        }
        const token = $("#sToken").value.trim() || s.token;
        await sync.updateServer(bit, { url, token, name: hostOf(url) });
        return overview;
      }),
    },
  );
  $("#sRemove").onclick = () => {
    sync.removeServer(bit).then(() => {
      toast("Server removed. Its copy stays on the server.");
      overview();
    });
  };
  $("#sDelete").onclick = () => confirmDelete(s);
}

function confirmDelete(s) {
  sheet(
    "Delete on Server",
    `<p class="lead">Delete all your logs on <b>${esc(s.name)}</b>, and the account they're in? Your devices and other servers keep their copies. This can't be undone.</p>
    <button class="danger solid" id="dYes">Delete on ${esc(s.name)}</button><div class="err"></div>`,
  );
  $("#dYes").onclick = () => {
    sync
      .deleteOnServer(s.bit)
      .then(() => {
        toast("Deleted on the server");
        overview();
      })
      .catch((e) => {
        $(".sheet .err").textContent = explain(e);
      });
  };
}

function addServer() {
  sheet(
    "Add Server",
    `${serverFields()}<p class="preview">The server's operator gives you the URL and a token.</p><div class="err"></div>`,
    {
      doneLabel: "Add",
      done: busy("Connecting…", async () => {
        const { url, token } = readServer();
        if (sync.servers.some((s) => s.url === url.replace(/\/+$/, "") && s.token === token))
          throw fail("You already sync with this server.");
        const { keyring } = await sync.inspect(url, token);
        if (keyring && keyring.vault !== sync.vault.keyring.vault)
          throw fail("This server holds someone else's logs (a different vault). Use another account or server.");
        await sync.addServer(url, token);
        return overview;
      }),
    },
  );
  $("#sUrl").focus();
}

function changePassphrase() {
  sheet(
    "Change Passphrase",
    `${passphraseForm(field("p0", "Current", CURRENT) + field("p1", "New", NEW) + field("p2", "Again", NEW))}
    <div class="strength" id="pStrength"></div><div class="err"></div>`,
    {
      doneLabel: "Change",
      done: busy("Changing…", async () => {
        const p = $("#p1").value;
        if (p.length < MIN_PASSPHRASE) throw fail(`Use at least ${MIN_PASSPHRASE} characters.`);
        if (p !== $("#p2").value) throw fail("The two new passphrases differ.");
        try {
          await sync.changePassphrase($("#p0").value, p);
        } catch (e) {
          if (e instanceof WrongPassphraseError) throw fail("That's not the current passphrase.");
          throw e;
        }
        toast("Passphrase changed");
        return overview;
      }),
    },
  );
  $("#p1").oninput = () => {
    $("#pStrength").textContent = strength($("#p1").value);
  };
  $("#p0").focus();
}
