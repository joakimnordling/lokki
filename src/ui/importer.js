// Importing files: read them, show what was understood (metrics, counts, a few values, how dates were read), and add
// the entries only when the person says so. Entries already here are skipped, so importing a file twice adds nothing.
import { decodeLoggrName } from "../core/csv.js";
import { dayLabel, esc, fmt, MON, parseLocal, timeLabel } from "../core/format.js";
import { uuid4, uuid5 } from "../core/ids.js";
import { normName } from "../core/names.js";
import { csvRows, readTable } from "../core/table.js";
import { commitRecs, fail, nextU, saveMetric } from "../data/records.js";
import { entriesOf, findMetricByName, metrics, rebuild, recs } from "../data/state.js";
import { $ } from "./dom.js";
import { ICON } from "./icons.js";
import { render } from "./render.js";
import { sheet, toast } from "./sheets.js";

let target = null; // a metric to import into (its ↓↑ button), or null for any

/** Opens the file picker; `mid`: import into that metric only. */
export function pickFiles(mid = null) {
  target = mid;
  const f = $("#fileIn");
  f.value = "";
  f.click();
}

const MONTH = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const WHY = {
  empty: "it's empty",
  nodates: "no column of dates found",
  novalues: "no numbers found next to the dates",
};

// A file's tables: CSV for now
async function tablesOf(file) {
  return [{ rows: csvRows(await file.text()), name: decodeLoggrName(file.name) }];
}

// Which of `list` (entries {s, v, n?}) metric `mid` doesn't have yet, as records ready to save. An entry is the same
// when its date, time and value are; the same one twice in a file is two entries if it's twice here too.
async function fresh(mid, list) {
  const have = new Map();
  if (mid)
    for (const e of entriesOf(mid)) {
      const k = `${e.s}|${e.v}`;
      have.set(k, (have.get(k) || 0) + 1);
    }
  const seen = new Map(),
    out = [];
  for (const r of [...list].sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))) {
    const k = `${r.s}|${r.v}`,
      i = seen.get(k) || 0;
    seen.set(k, i + 1);
    if (i < (have.get(k) || 0)) continue; // already have this one
    if (!mid) {
      out.push(r);
      continue;
    }
    const id = await uuid5(`${mid}|${r.s}|${r.v}|${i}`);
    if (recs.has(id)) continue; // known here (maybe since edited or deleted): a file never overrides that
    out.push({ ...r, id });
  }
  return out;
}

export async function importFiles(ev) {
  const into = target && metrics.has(target) ? target : null;
  target = null;
  const files = [...ev.target.files];
  if (!files.length) return;
  const sources = [],
    failed = [];
  for (const f of files) {
    try {
      for (const t of await tablesOf(f)) sources.push(t);
    } catch {
      failed.push(`${f.name}: couldn't be read`);
    }
  }
  openCheck(sources, failed, into);
}

// The check screen
function openCheck(sources, failed, into) {
  let order = null; // the person's choice of d.m.y / m.d.y, when the dates leave it open
  const read = () => {
    const out = { groups: new Map(), unsettled: false, order: "dmy", skipped: 0, unused: [], failed: [...failed] };
    for (const src of sources) {
      const r = readTable(src.rows, { name: src.name, order, locale: navigator.language });
      if (r.example) out.example ||= r.example;
      if (r.error) {
        out.failed.push(`${src.name}: ${WHY[r.error]}`);
        continue;
      }
      if (!r.settled || (order && r.example)) out.unsettled = true; // once asked, the question stays
      out.order = r.order;
      out.skipped += r.skipped;
      for (const u of r.unused) out.unused.push(`“${u}” in ${src.name}`);
      for (const g of r.groups) {
        const k = g.name.toLowerCase();
        if (!out.groups.has(k)) out.groups.set(k, { name: g.name, entries: [], bad: 0 });
        const x = out.groups.get(k);
        x.entries.push(...g.entries);
        x.bad += g.bad;
      }
    }
    return out;
  };
  let r = read();
  if (!r.groups.size) {
    toast(r.failed.length ? `Nothing to import: ${r.failed.join("; ")}.` : "No entries found in those files.");
    return;
  }
  // Into one metric: one card, for the column (or metric in the file) chosen
  let pick = 0;
  const cardsOf = () => {
    const gs = [...r.groups.values()];
    if (!into) return gs.map((g) => ({ ...g }));
    if (pick >= gs.length) pick = 0;
    return [{ ...gs[pick], name: metrics.get(into).name, from: gs, fromName: gs[pick].name }];
  };
  let cards = cardsOf();
  const intoName = into ? metrics.get(into).name : "";
  const close = sheet(into ? `Import into ${intoName}` : "Import", `<div id="imp"></div>`, {
    cls: "tint import-sheet",
  });
  const box = $("#imp");

  const preview = (entries) => {
    const sorted = [...entries].sort((a, b) => (a.s < b.s ? -1 : 1));
    const dateOnly = sorted.every((e) => e.s.endsWith("T12:00:00"));
    const line = (e) =>
      `<li><span>${esc((dateOnly ? dayLabel : timeLabel)(parseLocal(e.s)))}</span><b>${fmt(e.v)}</b></li>`;
    const head = sorted.slice(0, 2),
      tail = sorted.length > 4 ? sorted.slice(-2) : sorted.slice(2);
    return `<ul class="iprev">${head.map(line).join("")}${sorted.length > 4 ? `<li class="more">…</li>` : ""}${tail.map(line).join("")}</ul>`;
  };
  const span = (entries) => {
    const ss = entries.map((e) => e.s).sort();
    const m = (s) => {
      const d = parseLocal(s);
      return `${MON[d.getMonth()]} ${d.getFullYear()}`;
    };
    return m(ss[0]) === m(ss.at(-1)) ? m(ss[0]) : `${m(ss[0])} – ${m(ss.at(-1))}`;
  };

  // Each card's metric (existing or new) and how many of its entries are new; worked out again as names change
  const status = async (c) => {
    const name = normName(c.name);
    const mid = into || (name ? findMetricByName(name) : null);
    c.mid = mid;
    c.fresh = name ? await fresh(mid, c.entries) : [];
  };
  const total = () => cards.reduce((a, c) => a + (c.fresh?.length || 0), 0);
  const statusText = (c) => {
    const name = normName(c.name);
    if (!name) return `<span class="ierr">Give it a name to import it.</span>`;
    const dup = c.entries.length - c.fresh.length;
    const what = c.mid ? `Adds to your ${esc(metrics.get(c.mid)?.name || name)}` : "New metric";
    return `${what}${dup ? ` · ${plural(dup, "already there", "already there")}` : ""}`;
  };
  const updateCard = async (i) => {
    const c = cards[i];
    await status(c);
    const el = box.querySelector(`[data-card="${i}"] .istatus`);
    if (el) el.innerHTML = statusText(c);
    updateGo();
  };
  const updateGo = () => {
    const n = total(),
      go = $("#iGo");
    if (!go) return;
    go.disabled = !n;
    go.textContent = n ? `Import ${plural(n, "Entry", "Entries")}` : "Nothing New to Import";
  };

  const draw = async () => {
    await Promise.all(cards.map(status));
    if (!total() && !r.failed.length && !r.skipped) {
      // Everything's here already: nothing to check
      close();
      const n = cards.reduce((a, c) => a + c.entries.length, 0);
      toast(`Nothing new to import: all ${plural(n, "entry", "entries")} are already here`);
      return;
    }
    // When the dates could be day.month or month.day, one of them, both ways
    const [a, b, written] = r.example || [3, 4, "3.4."];
    const orderRow = r.unsettled
      ? `<div class="field iorder"><label for="iOrder">${esc(written)} is</label><span class="tpick"><span id="iOrderName"></span>${ICON.r}<select id="iOrder">
          <option value="dmy" ${r.order === "dmy" ? "selected" : ""}>${a} ${MONTH[b - 1]}</option>
          <option value="mdy" ${r.order === "mdy" ? "selected" : ""}>${MONTH[a - 1]} ${b}</option></select></span></div>`
      : "";
    const notes = [
      ...r.failed,
      ...(r.skipped ? [`${plural(r.skipped, "row")} without a readable date`] : []),
      ...cards.filter((c) => c.bad).map((c) => `${plural(c.bad, "value")} in ${esc(c.name)} that aren't numbers`),
      ...r.unused.map((u) => `${esc(u)}: text, not numbers`),
    ];
    box.innerHTML = `${orderRow}
      ${cards
        .map(
          (c, i) => `<div class="icard" data-card="${i}">
        ${
          into
            ? c.from.length > 1
              ? `<div class="field"><label for="iCol">Column</label><select id="iCol">${c.from
                  .map((g, j) => `<option value="${j}" ${j === pick ? "selected" : ""}>${esc(g.name)}</option>`)
                  .join("")}</select></div>`
              : ""
            : `<input class="iname" id="iName${i}" value="${esc(c.name)}" aria-label="Metric name" autocomplete="off">`
        }
        <div class="imeta">${plural(c.entries.length, "entry", "entries")} · ${span(c.entries)}</div>
        <div class="istatus">${statusText(c)}</div>
        ${preview(c.entries)}
      </div>`,
        )
        .join("")}
      ${notes.length ? `<details class="ileft"><summary>Not imported (${notes.length})</summary><ul>${notes.map((n) => `<li>${n}</li>`).join("")}</ul></details>` : ""}
      <button class="create" id="iGo"></button>`;
    updateGo();
    let t;
    cards.forEach((c, i) => {
      const inp = $(`#iName${i}`);
      if (inp)
        inp.oninput = () => {
          c.name = inp.value;
          clearTimeout(t);
          t = setTimeout(() => updateCard(i), 150);
        };
    });
    const col = $("#iCol");
    if (col)
      col.onchange = () => {
        pick = +col.value;
        cards = cardsOf();
        draw();
      };
    const ord = $("#iOrder");
    if (ord) $("#iOrderName").textContent = ord.selectedOptions[0].textContent;
    if (ord)
      ord.onchange = () => {
        order = ord.value;
        r = read();
        const names = cards.map((c) => c.name);
        cards = cardsOf();
        if (!into) for (const [i, c] of cards.entries()) c.name = names[i] ?? c.name;
        draw();
      };
    $("#iGo").onclick = async () => {
      close();
      await commit(cards, into);
    };
  };
  draw();
}

// Saves the cards' new entries, creating the metrics that don't exist yet; cards with the same name become one metric
async function commit(cards, into) {
  const byName = new Map();
  for (const c of cards) {
    const name = normName(c.name);
    if (!name && !into) continue;
    const k = into || name.toLowerCase();
    if (!byName.has(k)) byName.set(k, { name, entries: [] });
    byName.get(k).entries.push(...c.entries);
  }
  try {
    let added = 0,
      made = 0;
    const out = [];
    for (const { name, entries } of byName.values()) {
      let mid = into || findMetricByName(name);
      if (!mid) {
        mid = uuid4();
        const first = entries.reduce((a, e) => (a && a < e.s ? a : e.s), "");
        await saveMetric(mid, { name, type: "", created: first });
        made++;
      }
      for (const e of await fresh(mid, entries)) {
        out.push({ id: e.id, m: mid, y: +e.s.slice(0, 4), t: e.s, v: e.v, ...(e.n ? { n: e.n } : {}), u: nextU() });
        added++;
      }
    }
    if (out.length) await commitRecs(out);
    const metricsN = byName.size;
    toast(
      added
        ? `Imported ${plural(added, "entry", "entries")}${metricsN > 1 || made ? ` into ${plural(metricsN, "metric")}` : ""}`
        : "Nothing new to import",
    );
  } catch (e) {
    rebuild();
    render();
    fail(e);
  }
}
