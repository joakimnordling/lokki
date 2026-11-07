import { prefs } from "./prefs.js";

// Start of the day, week (on the configured first weekday) or month that time t falls in, as epoch ms.
export function startOf(t, gran, weekStart = prefs.weekStart) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  if (gran === "weekly") {
    const wd = (d.getDay() - weekStart + 7) % 7;
    d.setDate(d.getDate() - wd);
  } else if (gran === "monthly") {
    d.setDate(1);
  }
  return +d;
}
