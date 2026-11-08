// Per-device settings in localStorage, under "lokki:<name>".
export const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(`lokki:${k}`));
    } catch (_e) {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`lokki:${k}`, JSON.stringify(v));
    } catch (_e) {}
  },
};
export const LOOKS = [
  ["auto", "Automatic"],
  ["light", "Orange"],
  ["dark", "Dark"],
];
export function applyLook(l) {
  const r = document.documentElement;
  if (l === "light" || l === "dark") r.dataset.look = l;
  else delete r.dataset.look;
}
// Text size: the root font size, which every size in the stylesheet follows (rem), and a scale for the chart's labels.
export const TEXT_SIZES = [
  ["standard", "Standard", 17],
  ["large", "Large", 19],
  ["larger", "Larger", 21],
];
export const textScale = () => (TEXT_SIZES.find(([k]) => k === store.get("text")) ?? TEXT_SIZES[0])[2] / 17;
export function applyTextSize(k) {
  const size = TEXT_SIZES.find(([key]) => key === k);
  const r = document.documentElement;
  if (size && size[0] !== "standard") r.style.setProperty("--text", `${size[2]}px`);
  else r.style.removeProperty("--text");
}
export const prefs = {
  weekStart: store.get("weekStart") === 0 ? 0 : 1, // 1 = Monday (default), 0 = Sunday
  h24: store.get("h24") !== false, // 24-hour clock by default
};

/* The chart view of each metric (All Values / Averages / Totals, Daily / Weekly / Monthly) is per device: it isn't
   synced, so switching it on one device never changes another. Metrics from before this kept their view in the
   metric record; that is used until this device saves a view of its own. */
export const MODES = ["all", "avg", "totals"];
export const GRANS = ["daily", "weekly", "monthly"];
export function viewOf(mid, metric) {
  const saved = store.get(`view:${mid}`);
  const mode = saved?.mode ?? metric?.mode;
  const gran = saved?.gran ?? metric?.gran;
  return { mode: MODES.includes(mode) ? mode : null, gran: GRANS.includes(gran) ? gran : null };
}
export function setView(mid, view) {
  store.set(`view:${mid}`, view);
}
/** Whether this device has saved a view of its own for a metric. */
export const hasView = (mid) => store.get(`view:${mid}`) !== null;
