// Preferences sheet.
import { fmt } from "../core/format.js";
import { applyLook, LOOKS, prefs, store } from "../core/prefs.js";
import { metrics, outbox, S, ui } from "../data/state.js";
import { backUp } from "./backup.js";
import { $ } from "./dom.js";
import { exportAll } from "./files.js";
import { render } from "./render.js";
import { sheet } from "./sheets.js";

export function openSettings() {
  const total = [...S.entryCache.values()].reduce((a, b) => a + b.length, 0);
  const look = store.get("look") || "auto";
  const { weekStart, h24 } = prefs;
  const close = sheet(
    "Preferences",
    `<div class="setrow" style="display:block"><span>Appearance<small>Automatic follows your phone's Light/Dark setting. Saved on this device.</small></span>
    <div class="seg insheet" role="group" aria-label="Appearance">${LOOKS.map(([k, l]) => `<button data-look="${k}" aria-pressed="${look === k}">${l}</button>`).join("")}</div></div>
    <div class="setrow" style="display:block"><span>Week Starts On<small>Used for weekly totals and averages, and the day-of-week list. Saved on this device.</small></span>
    <div class="seg insheet" role="group" aria-label="Week starts on"><button data-ws="1" aria-pressed="${weekStart === 1}">Monday</button><button data-ws="0" aria-pressed="${weekStart === 0}">Sunday</button></div></div>
    <div class="setrow" style="display:block"><span>Time Format<small>How times are shown in the app. Saved on this device.</small></span>
    <div class="seg insheet" role="group" aria-label="Time format"><button data-h24="1" aria-pressed="${h24}">24-Hour</button><button data-h24="0" aria-pressed="${!h24}">AM/PM</button></div></div>
    <button class="setrow" id="sBak"><span>Back Up<small>Saves everything, including log types, view settings and deletions, to a Lokki backup file (.zip).</small></span><span>›</span></button>
    <button class="setrow" id="sRes"><span>Restore from Backup<small>Merges a Lokki backup into the app. Shows what will change before anything does.</small></span><span>›</span></button>
    <button class="setrow" id="sExp"><span>Export CSV<small>Every entry as metric, date, value and note, for spreadsheets.</small></span><span>›</span></button>
    <button class="setrow" id="sImp"><span>Import CSV<small>Adds entries from CSV files, including the old Loggr app's. Entries you already have are skipped.</small></span><span>›</span></button>
    <div class="preview" style="padding-top:14px">${metrics.size} metrics · ${fmt(total)} entries. ${S.local ? "Saved on this device only." : `Saved on this device and synced privately through your claude.ai account${outbox.size ? ` (${outbox.size} waiting to sync)` : ""}.`}</div>`,
    { cancel: "Done" },
  );
  const group = (attr, fn) => {
    const bs = document.querySelectorAll(`.sheet [${attr}]`);
    for (const b of bs)
      b.onclick = () => {
        fn(b);
        for (const x of bs) x.setAttribute("aria-pressed", String(x === b));
        render();
      };
  };
  group("data-look", (b) => {
    const k = b.dataset.look;
    store.set("look", k);
    applyLook(k);
  });
  group("data-ws", (b) => {
    prefs.weekStart = +b.dataset.ws;
    store.set("weekStart", prefs.weekStart);
    ui.sel = null;
  });
  group("data-h24", (b) => {
    prefs.h24 = b.dataset.h24 === "1";
    store.set("h24", prefs.h24);
  });
  $("#sExp").onclick = () => {
    close();
    exportAll();
  };
  $("#sImp").onclick = () => {
    close();
    $("#fileIn").value = "";
    $("#fileIn").click();
  };
  $("#sBak").onclick = () => {
    close();
    backUp();
  };
  $("#sRes").onclick = () => {
    close();
    $("#bakIn").value = "";
    $("#bakIn").click();
  };
}
