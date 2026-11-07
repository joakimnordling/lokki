// Per-device settings in localStorage. Keys moved from "loggr:" to "lokki:"; an old value is copied over the first time it's read.
export const store = {
  get(k) {
    try {
      let v = localStorage.getItem(`lokki:${k}`);
      if (v === null) {
        v = localStorage.getItem(`loggr:${k}`);
        if (v !== null) localStorage.setItem(`lokki:${k}`, v);
      }
      return JSON.parse(v);
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
export const prefs = {
  weekStart: store.get("weekStart") === 0 ? 0 : 1, // 1 = Monday (default), 0 = Sunday
  h24: store.get("h24") !== false, // 24-hour clock by default
};
