// Preferences extras: the privacy note, clearing this device's data, and which version this is.
import { esc, fmt } from "../core/format.js";
import { BUILD, REPO, sourceUrl } from "../core/version.js";
import { clearCopy, clearEverything } from "../data/clear.js";
import { sync } from "../sync/manager.js";
import { backUp } from "./backup.js";
import { $ } from "./dom.js";
import { sheet } from "./sheets.js";

export function openPrivacy() {
  const where = `<p class="lead"><b>On this device.</b> Your logs are saved in this browser. Lokki has no accounts, ads, analytics or tracking, and loads nothing from other sites: the fonts and icons come with the app. Loading the app itself is an ordinary visit to the website hosting it.</p>
       <p class="lead"><b>Sync.</b> If you set it up, your logs go only to the servers you add, encrypted on this device with a key made from your passphrase. A server sees how many rows you have, how big they are and when they change, but not your log names, values or notes. Nobody can read them without the passphrase, the server's operator included, and nobody can recover them if you forget it.</p>`;
  sheet(
    "Privacy",
    `${where}<p class="lead"><b>Backups and exports</b> are ordinary files that aren't encrypted. Keep them somewhere you trust.</p>
     <p class="lead">Lokki is open source: <a href="${REPO}" target="_blank" rel="noopener">see exactly what it does</a>.</p>`,
    { cancel: "Close" },
  );
}

/** Version and source link, for the bottom of Preferences. */
export function versionLine() {
  const commit = BUILD.commit ? ` · <span class="mono">${esc(BUILD.commit.slice(0, 7))}</span>` : "";
  const built = BUILD.built ? ` · built ${esc(BUILD.built)}` : "";
  return `Lokki ${esc(BUILD.version)}${commit}${built} · <a href="${esc(sourceUrl())}" target="_blank" rel="noopener">Source on GitHub</a>`;
}

export function openClear() {
  const synced = sync.vault && sync.servers.length;
  const lost = synced ? sync.status().unsynced : 0;
  const warn = lost
    ? `<p class="lead warn">${lost === 1 ? "1 change hasn't" : `${fmt(lost)} changes haven't`} reached any server yet and would be lost. Sync first, or back up.</p>`
    : "";
  let body;
  if (!synced)
    body = `<p class="lead">Your logs are saved only on this device. Clearing removes them for good, unless you have a backup.</p>
      <button class="plain" id="cBak">Back Up First</button>
      <button class="danger" id="cAll">Clear Everything</button>
      <p class="preview">Removes your logs and this device's preferences.</p>`;
  else
    body = `<p class="lead">This removes data from this device only. Your servers keep your logs.</p>${warn}
      <button class="plain" id="cCopy">Clear and Download Again</button>
      <p class="preview">Removes this device's copy of your logs and downloads it again. Your sync setup and preferences stay.</p>
      <button class="danger" id="cAll">Clear Everything</button>
      <p class="preview">Also removes the sync setup and this device's preferences. To sync again, you'll need each server's URL and token, and your passphrase.</p>`;
  const close = sheet("Clear Data", body);
  const bak = $("#cBak");
  if (bak)
    bak.onclick = () => {
      close();
      backUp();
    };
  const copy = $("#cCopy");
  if (copy)
    copy.onclick = () =>
      confirm(
        "Clear and Download Again",
        `Remove this device's copy of your logs, and download it again from ${sync.servers.length > 1 ? "your servers" : "your server"}?`,
        () => clearCopy(sync.servers),
      );
  $("#cAll").onclick = () =>
    confirm(
      "Clear Everything",
      synced
        ? "Remove your logs and settings from this device?"
        : "Remove your logs from this device for good? They aren't saved anywhere else.",
      clearEverything,
    );
}

function confirm(title, question, run) {
  sheet(
    title,
    `<p class="lead">${esc(question)} This can't be undone.</p>
    <button class="danger solid" id="cYes">${esc(title)}</button><div class="err"></div>`,
  );
  $("#cYes").onclick = async () => {
    $("#cYes").disabled = true;
    try {
      await run();
    } catch (e) {
      $("#cYes").disabled = false;
      $(".sheet .err").textContent = e?.message || "Couldn't clear the data.";
    }
  };
}
