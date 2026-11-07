import { periodLabel, timeLabel } from "../core/format.js";
import { startOf } from "../core/periods.js";
import { entriesOf } from "./state.js";

// The chart's points: every entry ("all"), or per day/week/month sums ("totals") or means ("avg").
export function series(mid, mode, gran) {
  const es = entriesOf(mid);
  if (mode === "all") return es.map((e) => ({ t: e.t, v: e.v, label: timeLabel(e.t), n: 1 }));
  const m = new Map();
  for (const e of es) {
    const k = startOf(e.t, gran);
    const g = m.get(k) || { t: k, sum: 0, n: 0 };
    g.sum += e.v;
    g.n++;
    m.set(k, g);
  }
  return [...m.values()]
    .sort((a, b) => a.t - b.t)
    .map((g) => ({ t: g.t, v: mode === "totals" ? g.sum : g.sum / g.n, n: g.n, label: periodLabel(g.t, gran) }));
}
