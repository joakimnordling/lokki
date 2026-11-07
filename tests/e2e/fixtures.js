// Synthetic data for the end-to-end tests: a few metrics with a few years of entries, generated the same way every
// time. (Never use real personal data in tests.)
import { uuid5 } from "../../src/core/ids.js";

const p2 = (n) => String(n).padStart(2, "0");
const naive = (d) =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00`;
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const METRICS = {
  running: { name: "Running", type: "Fitness", created: "2023-01-01T08:00:00", mode: "totals", gran: "monthly" },
  "body-weight": { name: "Body Weight", type: "Health", created: "2023-01-01T08:00:00", mode: "all" },
  cycling: { name: "Cycling", type: "Fitness", created: "2023-01-02T08:00:00" },
  gym: { name: "Gym", type: "Fitness", created: "2023-01-03T08:00:00" },
  cafe: { name: "Café", type: "Fitness", created: "2023-01-04T08:00:00" },
  reading: { name: "Reading", type: "Hobbies", created: "2023-01-05T08:00:00" },
};
// every: days between entries; value(r): a value from a random number in [0,1)
const PLAN = {
  running: { every: 3, value: (r) => Math.round((3 + r * 9) * 10) / 10 },
  "body-weight": { every: 7, value: (r) => Math.round((76 + r * 8) * 10) / 10 },
  cycling: { every: 5, value: (r) => Math.round(5 + r * 35) },
  gym: { every: 4, value: () => 1 },
  cafe: { every: 7, value: (r) => Math.round(1 + r * 4) },
  reading: {
    every: 2,
    value: (r) => Math.round(5 + r * 45),
    note: (r) => (r < 0.1 ? "with a note, and a comma" : null),
  },
};
const FIRST = new Date(2023, 0, 1, 7, 30);
const LAST = new Date(2026, 10, 6, 21, 0);
export const BASE_U = 1_760_000_000_000;

// { metrics: Map(id -> doc), docs: Map("<metric>~<year>" -> {m,y,e}), entries: [{id,m,t,v,n}] }
export async function makeData() {
  const metrics = new Map(),
    docs = new Map(),
    entries = [];
  let u = BASE_U;
  for (const [mid, m] of Object.entries(METRICS)) {
    metrics.set(mid, { ...m, u: u++ });
    const plan = PLAN[mid],
      r = rng(mid.length * 7919);
    const seen = new Map();
    for (let d = new Date(FIRST); d <= LAST; d.setDate(d.getDate() + plan.every)) {
      const at = new Date(d);
      at.setMinutes(at.getMinutes() + Math.floor(r() * 600));
      const t = naive(at),
        v = plan.value(r()),
        n = plan.note ? plan.note(r()) : null;
      const k = `${t}|${v}`,
        i = seen.get(k) || 0;
      seen.set(k, i + 1);
      const id = await uuid5(`${mid}|${t}|${String(v)}|${i}`);
      const doc = `${mid}~${t.slice(0, 4)}`;
      if (!docs.has(doc)) docs.set(doc, { m: mid, y: +t.slice(0, 4), e: {} });
      docs.get(doc).e[id] = { t, v, n, u: u++, d: false };
      entries.push({ id, m: mid, t, v, n });
    }
  }
  return { metrics, docs, entries };
}

// The old Loggr app's CSV export: one file per metric, no header, AM/PM times, non-ASCII names encoded as #U00e4.
export function oldLoggrFiles(entries) {
  const files = new Map();
  for (const e of entries) {
    const name = METRICS[e.m].name.replace(
      /[^\x20-\x7e]/g,
      (c) => `#U${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const [date, time] = e.t.split("T");
    const [y, mo, d] = date.split("-").map(Number);
    let [h, mi, s] = time.split(":").map(Number);
    const ap = h < 12 ? "AM" : "PM";
    h = h % 12 || 12;
    const line = `${y}-${mo}-${d} ${h}:${p2(mi)}:${p2(s)} ${ap}, ${e.v}${e.n ? `, "${e.n}"` : ""}\n`;
    files.set(`${name}.csv`, (files.get(`${name}.csv`) || "") + line);
  }
  return files;
}
