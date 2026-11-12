// Bottom sheets (entry, metric, log type filter, delete) and toasts.
import { evalExpr } from "../core/expr.js";
import { esc, fmt, parseLocal, toLocalStr } from "../core/format.js";
import { uuid4 } from "../core/ids.js";
import { normName, sameName } from "../core/names.js";
import { setView, store } from "../core/prefs.js";
import { SUGGESTIONS } from "../core/suggestions.js";
import { addEntry, deleteMetric, editEntry, saveMetric } from "../data/records.js";
import { entriesOf, metrics, ui } from "../data/state.js";
import { loadView } from "./detail.js";
import { $ } from "./dom.js";
import { ICON, TYPE_ICON, TYPES } from "./icons.js";
import { render } from "./render.js";

export function sheet(title, body, { done, doneLabel = "Done", cancel = "Cancel", cls = "" } = {}) {
  const L = $("#layer");
  L.innerHTML = `<div class="scrim" id="scrim"><div class="sheet gut ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="top"><button class="cancel" id="sCancel">${cancel}</button><h3>${esc(title)}</h3>${done ? `<button class="done" id="sDone">${doneLabel}</button>` : "<span></span>"}</div>${body}</div></div>`;
  const close = () => {
    L.innerHTML = "";
  };
  $("#sCancel").onclick = close;
  $("#scrim").onclick = (e) => {
    if (e.target.id === "scrim") close();
  };
  if (done)
    $("#sDone").onclick = () => {
      if (done() !== false) close();
    };
  const k = (e) => {
    if (e.key === "Escape") {
      close();
      removeEventListener("keydown", k);
    }
  };
  addEventListener("keydown", k);
  return close;
}
export function toast(msg, action) {
  for (const x of document.querySelectorAll(".toast")) x.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => {
      t.remove();
      action.fn();
    };
    t.appendChild(b);
  }
  document.body.appendChild(t);
  setTimeout(() => t.remove(), action ? 6000 : 2400);
}
export function openEntrySheet(mid, entry) {
  const m = metrics.get(mid);
  if (!m) return;
  const when = entry ? entry.s.slice(0, 16) : toLocalStr(new Date()).slice(0, 16);
  sheet(
    m.name,
    `<div class="field"><input class="big" id="eVal" inputmode="decimal" autocomplete="off" placeholder="Value" value="${entry ? esc(String(entry.v).replace(".", ",")) : ""}"></div>
    <div class="ops">${["÷", "×", "−", "+"].map((o) => `<button data-op="${o}">${o}</button>`).join("")}</div><div class="preview" id="ePrev"></div>
    <div class="field"><label for="eDate">Date</label><input type="datetime-local" id="eDate" value="${when}"></div>
    <div class="field"><input id="eNote" placeholder="Enter Note For Entry" style="text-align:left" value="${entry ? esc(entry.n) : ""}"></div><div class="err" id="eErr"></div>
    `,
    {
      done: () => {
        const v = evalExpr($("#eVal").value);
        if (v == null) {
          $("#eErr").textContent = "Enter a number, for example 5,5 or 2+3.";
          return false;
        }
        const dv = $("#eDate").value;
        if (!dv) {
          $("#eErr").textContent = "Pick a date.";
          return false;
        }
        const s = toLocalStr(parseLocal(dv));
        const note = $("#eNote").value.trim();
        (async () => {
          if (entry) await editEntry(entry, s, v, note);
          else await addEntry(mid, s, v, note);
          toast(entry ? "Entry updated" : `Logged ${fmt(v)}`);
        })();
      },
    },
  );
  // Focus right away, inside the tap that opened the sheet: iPhone only raises the keyboard for focus requested during a tap.
  const inp = $("#eVal");
  inp.focus();
  if (entry) {
    const n = inp.value.length;
    try {
      inp.setSelectionRange(n, n);
    } catch (_e) {}
  }
  const upd = () => {
    const raw = inp.value;
    const v = evalExpr(raw);
    $("#ePrev").textContent = /[-+×÷*/()−]/.test(raw.replace(/^-/, "")) && v != null ? `= ${fmt(v)}` : "";
  };
  inp.oninput = upd;
  for (const b of document.querySelectorAll("[data-op]"))
    b.onclick = () => {
      const o = b.dataset.op;
      inp.value += o;
      upd();
      inp.focus();
    };
}
// A metric's name: none taken already (by another metric than `mid`), or the message saying what's wrong
function nameProblem(name, mid) {
  if (!name) return "Give the metric a name.";
  if ([...metrics.entries()].some(([id, x]) => id !== mid && sameName(x.name, name)))
    return "You already have a metric with that name.";
  return "";
}
const typeIcon = (t) => `<svg viewBox="0 0 24 24" aria-hidden="true">${TYPE_ICON[t] || TYPE_ICON[""]}</svg>`;
const has = (name) => [...metrics.values()].some((x) => sameName(x.name, name));

export function openMetricSheet(mid) {
  if (!mid) return openCreateSheet();
  const m = metrics.get(mid);
  sheet(
    "Edit Log",
    `<div class="field"><input class="big" id="mName" placeholder="Metric Name" value="${esc(m.name)}" autocomplete="off"></div>
    <div class="field"><label for="mType">Log Type</label><select id="mType"><option value="">Optional</option>${TYPES.map((t) => `<option ${m.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></div><div class="err" id="mErr"></div>`,
    {
      done: () => {
        const name = normName($("#mName").value);
        const problem = nameProblem(name, mid);
        if (problem) {
          $("#mErr").textContent = problem;
          return false;
        }
        saveMetric(mid, { ...m, name, type: $("#mType").value });
      },
    },
  );
  $("#mName").focus();
}

// Create Metric: your own at the top, ready-made ones below. A suggestion is added with one tap and starts in the
// chart view that suits it (src/core/suggestions.js); one you already have, by name, shows as added.
function openCreateSheet() {
  const close = sheet(
    "Create Metric",
    `<h4 class="ctitle">Add Your Own</h4>
    <div class="field"><input id="mName" placeholder="Name" autocomplete="off" aria-label="Name"></div>
    <div class="field"><label for="mType">Type</label><span class="tpick"><span class="ticon" id="mIcon">${typeIcon("")}</span><span id="mTypeName">None</span>${ICON.r}<select id="mType"><option value="">None</option>${TYPES.map((t) => `<option>${t}</option>`).join("")}</select></span></div>
    <div class="err" id="mErr"></div>
    <button class="create" id="mAdd" disabled>Add</button>
    <h4 class="ctitle sugg">Suggestions</h4>
    ${SUGGESTIONS.map(
      ([type, items]) =>
        `<div class="sgroup"><h5>${typeIcon(type)}${esc(type)}</h5>${items
          .map(
            ([name], i) =>
              `<div class="srow"><span>${esc(name)}</span><button class="sadd" data-sugg="${esc(type)}:${i}">Add</button></div>`,
          )
          .join("")}</div>`,
    ).join("")}`,
    { cancel: "Close", cls: "tint create-sheet" },
  );
  const name = $("#mName"),
    type = $("#mType"),
    add = $("#mAdd");
  name.oninput = () => {
    add.disabled = !normName(name.value);
    $("#mErr").textContent = "";
  };
  type.onchange = () => {
    $("#mIcon").innerHTML = typeIcon(type.value);
    $("#mTypeName").textContent = type.value || "None";
  };
  add.onclick = () => {
    const n = normName(name.value);
    const problem = nameProblem(n);
    if (problem) {
      $("#mErr").textContent = problem;
      return;
    }
    const id = uuid4();
    close();
    saveMetric(id, { name: n, type: type.value, created: toLocalStr(new Date()) }); // in memory at once, then saved
    // straight to the new metric, so its first entry is a tap away
    ui.view = "detail";
    ui.mid = id;
    loadView(id);
    ui.sel = null;
    render();
    window.scrollTo(0, 0);
  };
  const mark = (b) => {
    b.textContent = "✓ Added";
    b.disabled = true;
  };
  for (const b of document.querySelectorAll("[data-sugg]")) {
    const [t, i] = b.dataset.sugg.split(":");
    const [n, mode, gran] = SUGGESTIONS.find(([x]) => x === t)[1][+i];
    if (has(n)) mark(b);
    b.onclick = () => {
      if (has(n)) return mark(b);
      const id = uuid4();
      setView(id, { mode, gran });
      saveMetric(id, { name: n, type: t, created: toLocalStr(new Date()) });
      mark(b);
      toast(`Added ${n}`);
    };
  }
}
export function openTypeFilter() {
  const counts = { "": metrics.size };
  for (const m of metrics.values()) if (m.type) counts[m.type] = (counts[m.type] || 0) + 1;
  const used = new Set(Object.keys(counts).filter(Boolean));
  const items = [["", "All Metrics"], ...TYPES.filter((t) => used.has(t)).map((t) => [t, t])];
  const ic = (k) =>
    `<span class="c"><svg viewBox="0 0 24 24">${TYPE_ICON[k] || TYPE_ICON[""]}</svg><span class="badge" aria-label="${counts[k]} metrics">${counts[k]}</span></span>`;
  const close = sheet(
    "Select Log Type",
    `<div class="tgrid">${items.map(([k, l]) => `<button data-t="${esc(k)}" aria-pressed="${ui.filter === k}">${ic(k)}<span>${esc(l)}</span></button>`).join("")}</div>
    ${used.size ? "" : `<div class="note">Give metrics a log type (pencil button on a metric) to filter by it.</div>`}`,
    { cls: "tint" },
  );
  for (const b of document.querySelectorAll("[data-t]"))
    b.onclick = () => {
      ui.filter = b.dataset.t;
      store.set("filter", ui.filter);
      close();
      render();
    };
}
export function openDeleteMetric() {
  const m = metrics.get(ui.mid),
    n = entriesOf(ui.mid).length;
  const close = sheet(
    "Delete Metric",
    `<p style="line-height:1.5">Delete <b>${esc(m.name)}</b> and all ${n} of its entries? This can't be undone. Export your data first if you might want it back.</p>
    <button class="danger solid" id="dYes">Delete ${esc(m.name)}</button>`,
  );
  $("#dYes").onclick = () => {
    const mid = ui.mid;
    close();
    deleteMetric(mid);
    toast("Metric deleted");
  };
}
