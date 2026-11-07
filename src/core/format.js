import { prefs } from "./prefs.js";

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nf = new Intl.NumberFormat("fi-FI", { maximumFractionDigits: 2 });
export const fmt = (v) => (Number.isFinite(v) ? nf.format(v) : "–");
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const p2 = (n) => String(n).padStart(2, "0");
export const toLocalStr = (d) =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
export const parseLocal = (s) => new Date(s.length === 16 ? `${s}:00` : s);

export function md(d) {
  return `${MON[d.getMonth()]} ${p2(d.getDate())}`;
}
export function clock(t) {
  const d = new Date(t);
  if (prefs.h24) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  let h = d.getHours();
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${p2(d.getMinutes())} ${ap}`;
}
export function dayLabel(t) {
  const d = new Date(t);
  return `${MON[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}
export function periodLabel(t, gran) {
  const d = new Date(t),
    yr = ` ${d.getFullYear()}`;
  if (gran === "monthly") return `${MON[d.getMonth()]} ${d.getFullYear()}`;
  if (gran === "weekly") {
    const e = new Date(t);
    e.setDate(e.getDate() + 6);
    return e.getFullYear() === d.getFullYear()
      ? `${md(d)} - ${md(e)}${yr}`
      : `${md(d)}${yr} - ${md(e)} ${e.getFullYear()}`;
  }
  return md(d) + yr;
}
export function timeLabel(t) {
  const d = new Date(t);
  return `${md(d)} ${d.getFullYear()} - ${clock(t)}`;
}
export function ago(t, now = Date.now()) {
  const s = (now - t) / 1000;
  const u = [
    [31536000, "year"],
    [2592000, "month"],
    [604800, "week"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [sec, name] of u) {
    const n = Math.floor(s / sec);
    if (n >= 1) return `${n} ${name}${n > 1 ? "s" : ""} ago`;
  }
  return "Just now";
}
