// A metric's detail view: chart, period value, statistics, correlation, rank, distribution and day of week.
import { DOW, esc, fmt } from "../core/format.js";
import { prefs, setView, store, viewOf } from "../core/prefs.js";
import { pearson, stats } from "../core/stats.js";
import { series } from "../data/series.js";
import { entriesOf, metrics, ui } from "../data/state.js";
import { chartScroll, drawChart } from "./chart.js";
import { $ } from "./dom.js";
import { goEntries } from "./entries.js";
import { ICON } from "./icons.js";

export function detailRender() {
  const main = $("#main"),
    mid = ui.mid,
    mode = ui.mode,
    gran = ui.gran;
  const ser = series(mid, mode, gran);
  if (ui.sel == null || ui.sel < 0 || ui.sel >= ser.length) ui.sel = ser.length - 1;
  const st = stats(ser.map((x) => x.v));
  const cur = ser[ui.sel];
  const segBtn = (k, v, l) => `<button data-${k}="${v}" aria-pressed="${ui[k] === v}">${l}</button>`;
  let h = `<div class="seg">${segBtn("mode", "all", "All Values")}${segBtn("mode", "avg", "Averages")}${segBtn("mode", "totals", "Totals")}</div>`;
  h += `<div class="chartwrap"><div class="chart" id="chart" tabindex="0" aria-label="Chart. Use arrow keys to move between periods."><div class="spacer" id="spacer"></div></div><canvas id="cv"></canvas></div>`;
  if (mode !== "all")
    h += `<div class="seg">${segBtn("gran", "daily", "Daily")}${segBtn("gran", "weekly", "Weekly")}${segBtn("gran", "monthly", "Monthly")}</div>`;
  if (!ser.length) {
    main.innerHTML = `${h}<div class="state"><b>No entries yet</b>Tap + below to log the first value.</div>`;
    bindDetail();
    drawChart([]);
    return;
  }
  h += `<div class="nav"><div class="lbl">${esc(cur.label)}</div><div class="div"></div>
    <div class="val">${fmt(cur.v)}${mode === "avg" ? `<small>Per Entry · ${cur.n}</small>` : mode === "totals" && cur.n > 1 ? `<small>${cur.n} entries</small>` : ""}</div>
    <button id="nList" aria-label="Show all entries">${ICON.r}</button></div>`;
  h += `<div class="stats"><div>${fmt(st.min)}<small>Minimum</small></div><div>${fmt(st.max)}<small>Maximum</small></div><div>${fmt(st.mean)}<small>Mean</small></div>
    <div>${fmt(st.med)}<small>Median</small></div><div>${fmt(st.tot)}<small>Total</small></div><div>${fmt(st.sd)}<small>Deviation</small></div></div>`;
  // correlation
  h += `<div class="sec"><h2>Correlation</h2><div class="seg small">${segBtn("corr", "pos", "Positive")}${segBtn("corr", "neg", "Negative")}</div>`;
  if (mode === "all") h += `<div class="li muted">Select Averages or Totals</div>`;
  else {
    const mine = new Map(ser.map((x) => [x.t, x.v]));
    const res = [];
    for (const [id, m] of metrics) {
      if (id === mid) continue;
      const o = series(id, mode, gran);
      const a = [],
        b = [];
      for (const x of o) {
        if (mine.has(x.t)) {
          a.push(mine.get(x.t));
          b.push(x.v);
        }
      }
      const r = pearson(a, b);
      if (r != null && (ui.corr === "pos" ? r >= 0.3 : r <= -0.3)) res.push({ name: m.name, r, n: a.length });
    }
    res.sort((x, y) => (ui.corr === "pos" ? y.r - x.r : x.r - y.r));
    h += res.length
      ? res
          .slice(0, 5)
          .map((x) => `<div class="li"><span>${esc(x.name)}</span><span>${fmt(x.r)}</span></div>`)
          .join("")
      : `<div class="li muted">No Correlation Found</div>`;
  }
  h += `</div>`;
  // rank
  const step = ui.rankStep || 0,
    rn = step ? step * 10 : 5; // 5, then 10, 20, 30, ...
  const rAll = ser
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => (ui.rank === "high" ? b.v - a.v || b.t - a.t : a.v - b.v || b.t - a.t)),
    rk = rAll.slice(0, rn);
  const canMore = rAll.length > rn;
  h +=
    // the positions start at the edge like the other lists, in a column as wide as the longest one shown
    `<div class="sec" id="rankSec" style="--pos:${String(rk.length).length + 1}ch"><h2>Rank</h2><div class="seg small">${segBtn("rank", "high", "Highest")}${segBtn("rank", "low", "Lowest")}</div>` +
    rk
      .map(
        (x, j) =>
          `<button class="li rank" data-sel="${x.i}"><span class="pos">${j + 1}.</span><span>${esc(x.label)}</span><span>${fmt(x.v)}</span></button>`,
      )
      .join("") +
    (step || canMore
      ? `<div class="rmore">${step ? `<button data-rstep="0">Show less</button>` : ""}${canMore ? `<button data-rstep="1">Show more</button>` : ""}</div>`
      : "") +
    `</div>`;
  // distribution
  const B = 5,
    lo = st.min,
    hi = st.max,
    w = (hi - lo) / B || 1,
    cnt = Array(B).fill(0);
  for (const x of ser) {
    let k = Math.floor((x.v - lo) / w);
    if (k >= B) k = B - 1;
    if (k < 0) k = 0;
    cnt[k]++;
  }
  h +=
    `<div class="sec"><h2>Distribution</h2>` +
    (hi === lo
      ? `<div class="li"><span>${fmt(lo)}</span><span>100%</span></div>`
      : cnt
          .map((c, k) => {
            const pct = Math.round((c / ser.length) * 100);
            return `<div class="li dist"><span>${fmt(lo + k * w)} - ${fmt(lo + (k + 1) * w)}</span><span class="barbg"><i style="width:${pct}%"></i></span><span>${pct}%</span></div>`;
          })
          .join("")) +
    `</div>`;
  // day of week
  const dw = Array.from({ length: 7 }, () => ({ s: 0, n: 0 }));
  for (const e of entriesOf(mid)) {
    const d = new Date(e.t).getDay();
    dw[d].s += e.v;
    dw[d].n++;
  }
  h +=
    `<div class="sec" style="border-bottom:0"><h2>Averages by Day of Week</h2>` +
    [0, 1, 2, 3, 4, 5, 6]
      .map((j) => {
        const i = (j + prefs.weekStart) % 7,
          x = dw[i];
        return `<div class="li"><span>${DOW[i]}</span><span>${x.n ? fmt(x.s / x.n) : "–"}</span></div>`;
      })
      .join("") +
    `</div>`;
  main.innerHTML = h;
  bindDetail();
  drawChart(ser);
}
function bindDetail() {
  const all = (s, fn) => {
    for (const b of document.querySelectorAll(s)) b.onclick = () => fn(b);
  };
  all("[data-mode]", (b) => {
    ui.rankStep = 0;
    ui.mode = b.dataset.mode;
    store.set("mode", ui.mode);
    saveView();
    ui.sel = null;
    detailRender();
  });
  all("[data-gran]", (b) => {
    ui.rankStep = 0;
    ui.gran = b.dataset.gran;
    store.set("gran", ui.gran);
    saveView();
    ui.sel = null;
    detailRender();
  });
  all("[data-corr]", (b) => {
    ui.corr = b.dataset.corr;
    detailRender();
  });
  all("[data-rank]", (b) => {
    ui.rank = b.dataset.rank;
    ui.rankStep = 0;
    detailRender();
  });
  all("[data-rstep]", (b) => {
    const less = b.dataset.rstep === "0";
    ui.rankStep = less ? 0 : (ui.rankStep || 0) + 1;
    chartScroll.keep = $("#chart")?.scrollLeft ?? null;
    detailRender();
    if (less) {
      // the list shrank above the viewport: bring the Rank heading back just under the header
      const sec = $("#rankSec"),
        hb = $("#hdr").getBoundingClientRect().bottom,
        top = sec.getBoundingClientRect().top;
      if (top < hb || top > innerHeight * 0.6) {
        const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: scrollY + top - hb - 8, behavior: smooth ? "smooth" : "auto" });
      }
    }
  });
  all("[data-sel]", (b) => {
    ui.sel = +b.dataset.sel;
    detailRender();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const nl = $("#nList");
  if (nl) nl.onclick = goEntries;
}

/* Per-metric view (All Values/Averages/Totals + Daily/Weekly/Monthly), kept on this device (core/prefs.js) */
export function loadView(mid) {
  const view = viewOf(mid, metrics.get(mid));
  ui.rankStep = 0;
  ui.mode = view.mode || store.get("mode") || "totals";
  ui.gran = view.gran || store.get("gran") || "monthly";
}
function saveView() {
  if (metrics.has(ui.mid)) setView(ui.mid, { mode: ui.mode, gran: ui.gran });
}
