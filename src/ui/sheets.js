// Bottom sheets (entry, metric, log type filter, delete) and toasts.
import { evalExpr } from "../core/expr.js";
import { esc, fmt, parseLocal, toLocalStr } from "../core/format.js";
import { uuid4 } from "../core/ids.js";
import { normName, sameName } from "../core/names.js";
import { store } from "../core/prefs.js";
import { addEntry, deleteMetric, editEntry, saveMetric } from "../data/records.js";
import { entriesOf, metrics, ui } from "../data/state.js";
import { $ } from "./dom.js";
import { TYPE_ICON, TYPES } from "./icons.js";
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
export function openMetricSheet(mid) {
  const m = mid ? metrics.get(mid) : null;
  sheet(
    m ? "Edit Log" : "Custom Metric",
    `<div class="field"><input class="big" id="mName" placeholder="Custom Metric Name" value="${m ? esc(m.name) : ""}" autocomplete="off"></div>
    <div class="field"><label for="mType">Log Type</label><select id="mType"><option value="">Optional</option>${TYPES.map((t) => `<option ${m && m.type === t ? "selected" : ""}>${t}</option>`).join("")}</select></div><div class="err" id="mErr"></div>`,
    {
      done: () => {
        const name = normName($("#mName").value);
        if (!name) {
          $("#mErr").textContent = "Give the metric a name.";
          return false;
        }
        const dup = [...metrics.entries()].find(([id, x]) => id !== mid && sameName(x.name, name));
        if (dup) {
          $("#mErr").textContent = "You already have a metric with that name.";
          return false;
        }
        const type = $("#mType").value;
        if (m) saveMetric(mid, { ...m, name, type });
        else {
          saveMetric(uuid4(), { name, type, created: toLocalStr(new Date()) });
          toast(`Created ${name}`);
        }
      },
    },
  );
  $("#mName").focus();
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
