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
export const prefs = {
  weekStart: store.get("weekStart") === 0 ? 0 : 1, // 1 = Monday (default), 0 = Sunday
  h24: store.get("h24") !== false, // 24-hour clock by default
};
