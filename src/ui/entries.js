// The entry list of one metric (from the › next to the period value): search, swipe to delete, edit mode.
import { clock, dayLabel, esc, fmt } from "../core/format.js";
import { deleteEntry, restoreEntry } from "../data/records.js";
import { entriesOf, metrics, ui } from "../data/state.js";
import { $ } from "./dom.js";
import { ICON } from "./icons.js";
import { render } from "./render.js";
import { openEntrySheet, toast } from "./sheets.js";

const ekey = (e) => e.id;
export function goEntries() {
  ui.view = "entries";
  ui.edit = false;
  ui.q = "";
  ui.shown = 150;
  ui.armed = null;
  render();
  window.scrollTo(0, 0);
}
export function entriesRender() {
  const hdr = $("#hdr"),
    main = $("#main"),
    m = metrics.get(ui.mid);
  $("#toolbar").hidden = true;
  hdr.innerHTML = ui.edit
    ? `<button class="hbtn txt" id="eDone"><b>Done</b></button><h1>${esc(m.name)}</h1><button class="hbtn right txt" id="eNew">New Entry</button>`
    : `<button class="hbtn" id="eBack" aria-label="Back to ${esc(m.name)}">${ICON.back}</button><h1>${esc(m.name)}</h1><button class="hbtn right txt" id="eEdit">Edit</button>`;
  if (ui.edit) {
    $("#eDone").onclick = () => {
      ui.edit = false;
      ui.armed = null;
      render();
    };
    $("#eNew").onclick = () => openEntrySheet(ui.mid, null);
  } else {
    $("#eBack").onclick = () => {
      ui.view = "detail";
      render();
      window.scrollTo(0, 0);
    };
    $("#eEdit").onclick = () => {
      ui.edit = true;
      ui.armed = null;
      render();
    };
  }
  const tag = `entries:${ui.mid}`;
  if (main.dataset.view !== tag) {
    main.dataset.view = tag;
    main.innerHTML = `<div class="esearch"><input id="eq" type="search" placeholder="Search" aria-label="Search entries" autocomplete="off" enterkeyhint="search"></div><div id="elist"></div>`;
    const q = $("#eq");
    q.value = ui.q;
    q.oninput = () => {
      ui.q = q.value;
      ui.shown = 150;
      ui.armed = null;
      drawEntries();
    };
    bindEntryList($("#elist"));
  }
  drawEntries();
}
function filteredEntries() {
  const es = entriesOf(ui.mid).slice().reverse();
  const q = ui.q.trim().toLowerCase();
  if (!q) return es;
  return es.filter((e) => `${dayLabel(e.t)} ${clock(e.t)} ${fmt(e.v)} ${e.v} ${e.n}`.toLowerCase().includes(q));
}
function drawEntries() {
  const box = $("#elist");
  if (!box) return;
  const es = filteredEntries();
  ui.cur = es;
  if (!es.length) {
    box.innerHTML = `<div class="state">${ui.q ? "No entries match your search." : "<b>No entries yet</b>Tap New Entry or + to log the first value."}</div>`;
    return;
  }
  let h = "";
  for (let i = 0; i < Math.min(es.length, ui.shown); i++) {
    const e = es[i];
    h += `<div class="er${ui.armed === ekey(e) ? " armed" : ""}" data-i="${i}"><div class="in">
      ${ui.edit ? `<button class="minus" data-minus="${i}" aria-label="Delete entry from ${dayLabel(e.t)} ${clock(e.t)}"><i></i></button>` : ""}
      <button class="open" data-open="${i}"><span><span class="d">${dayLabel(e.t)}</span><span class="t">${clock(e.t)}</span>${e.n ? `<span class="n">${esc(e.n)}</span>` : ""}</span>
      <span class="v">${fmt(e.v)}</span>${ICON.chev}</button></div>
      <button class="del" data-del="${i}" tabindex="${ui.armed === ekey(e) ? 0 : -1}">Delete</button></div>`;
  }
  if (es.length > ui.shown) h += `<div class="note">Scroll for older entries · ${es.length} in total</div>`;
  box.innerHTML = h;
}
function bindEntryList(box) {
  let sx = 0,
    sy = 0,
    row = null,
    swiped = false;
  box.addEventListener(
    "touchstart",
    (ev) => {
      const t = ev.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      row = ev.target.closest(".er");
      swiped = false;
    },
    { passive: true },
  );
  box.addEventListener(
    "touchend",
    (ev) => {
      if (!row) return;
      const t = ev.changedTouches[0],
        dx = t.clientX - sx,
        dy = t.clientY - sy;
      if (Math.abs(dx) > 40 && Math.abs(dy) < 30) {
        swiped = true;
        const e = ui.cur[+row.dataset.i];
        const k = dx < 0 ? ekey(e) : null;
        if (ui.armed !== k) {
          ui.armed = k;
          for (const r of box.querySelectorAll(".er.armed")) {
            r.classList.remove("armed");
            r.querySelector(".del").tabIndex = -1;
          }
          if (k) {
            row.classList.add("armed");
            row.querySelector(".del").tabIndex = 0;
          }
        }
      }
      row = null;
    },
    { passive: true },
  );
  box.addEventListener("click", (ev) => {
    if (swiped) {
      swiped = false;
      return;
    }
    const del = ev.target.closest("[data-del]"),
      minus = ev.target.closest("[data-minus]"),
      open = ev.target.closest("[data-open]");
    if (del) {
      const e = ui.cur[+del.dataset.del];
      ui.armed = null;
      deleteWithUndo(e);
      return;
    }
    if (minus) {
      const e = ui.cur[+minus.dataset.minus];
      ui.armed = ui.armed === ekey(e) ? null : ekey(e);
      drawEntries();
      return;
    }
    if (open) {
      if (ui.armed) {
        ui.armed = null;
        drawEntries();
        return;
      }
      openEntrySheet(ui.mid, ui.cur[+open.dataset.open]);
    }
  });
}
function deleteWithUndo(e) {
  const old = deleteEntry(e);
  if (!old) return;
  toast(`Deleted ${fmt(e.v)} from ${dayLabel(e.t)}`, {
    label: "Undo",
    fn: () => {
      restoreEntry(old);
      toast("Entry restored");
    },
  });
}
// Loads older entries as the list is scrolled towards its end.
export function installEntryScroll() {
  addEventListener(
    "scroll",
    () => {
      if (ui.view !== "entries" || !ui.cur || ui.cur.length <= ui.shown) return;
      if (innerHeight + scrollY > document.body.scrollHeight - 900) {
        ui.shown += 300;
        drawEntries();
      }
    },
    { passive: true },
  );
}
