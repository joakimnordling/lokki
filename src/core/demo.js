/* Demo data: a year of made-up logs ending at a given moment, the same every time for the same moment.
   The app shows it at ?demo, in a database of its own (src/data/demo.js); the README's screenshots use it too
   (scripts/screenshots.js). Nothing here is anyone's real data. */

/** Whether this page is the demo: ?demo in its address. */
export const DEMO = typeof location !== "undefined" && new URLSearchParams(location.search).has("demo");

// A small seeded random number generator (mulberry32): the same numbers every run
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const p2 = (n) => String(n).padStart(2, "0");
const at = (d, h, m) =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(Math.floor(h))}:${p2(Math.floor(m))}:00`;
const round = (x, step) => +(Math.round(x / step) * step).toFixed(2);
// How far into summer a day is: 0 in midwinter, 1 at midsummer
const summer = (d) => (1 - Math.cos(((d - new Date(d.getFullYear(), 0, 1)) / 864e5 / 365) * 2 * Math.PI)) / 2;

export const DEMO_METRICS = [
  { id: "running", name: "Running", type: "Fitness", mode: "totals", gran: "weekly" },
  { id: "body-weight", name: "Body Weight", type: "Health", mode: "avg", gran: "monthly" },
  { id: "cycling", name: "Cycling", type: "Fitness" },
  { id: "swimming", name: "Swimming", type: "Fitness" },
  { id: "steps", name: "Steps", type: "Health" },
  { id: "sleep", name: "Sleep", type: "Health" },
  { id: "coffee", name: "Coffee", type: "Diet" },
  { id: "reading", name: "Reading", type: "Hobbies" },
  { id: "meditation", name: "Meditation", type: "Health" },
];

// One day's entries, as [metric, hour, minute, value]. i: the day's number in the year, days: how many there are.
function* day(d, i, days, r) {
  const between = (a, b) => a + r() * (b - a);
  const wd = d.getDay(); // 0 Sunday
  const s = summer(d);
  // Running: three or four times a week, longer in summer; an easy week now and then
  const easy = Math.floor(i / 7) % 6 === 5;
  if ([2, 4, 6].includes(wd) || (wd === 0 && r() < 0.4))
    if (r() < (easy ? 0.4 : 0.85)) {
      const long = wd === 6 ? 1.6 : 1;
      yield ["running", between(6, 8), between(0, 59), round(between(4.5, 7.5) * long * (0.7 + 0.6 * s), 0.1)];
    }
  // Cycling: mostly in the warmer half of the year, like running
  if ((wd === 1 || wd === 5 || wd === 0) && r() < 0.15 + 0.8 * s)
    yield ["cycling", 17, between(0, 59), Math.round(between(12, 30) * (0.6 + 0.8 * s))];
  // Steps: every evening, more in summer
  yield ["steps", 21, between(30, 59), Math.round(between(5500, 9500) + 3500 * s)];
  // Sleep: every morning, hours
  yield ["sleep", 7, between(30, 59), round(between(6.3, 8.4) + (wd === 0 || wd === 6 ? 0.6 : 0), 0.25)];
  // Meditation: some mornings, minutes
  if (r() < 0.45) yield ["meditation", 8, between(0, 59), [5, 10, 10, 15, 20][Math.floor(r() * 5)]];
  // Body weight: most mornings, from about 86 kg a year ago down to about 79 now, with plateaus and noise
  if (r() < 0.75) {
    const trend = 86 - (7 * i) / days + 0.8 * Math.sin(i / 23);
    yield ["body-weight", 7, between(0, 30), round(trend + between(-0.6, 0.6), 0.1)];
  }
  // Swimming: once a week, a bit more in summer
  if (wd === 3 && r() < 0.8) yield ["swimming", 18, between(0, 59), round(between(1, 1.6) + 0.5 * s, 0.05)];
  // Coffee: every day, more on weekdays
  const cups = Math.max(1, Math.round(between(1.5, 3.5) + (wd > 0 && wd < 6 ? 0.8 : -0.3)));
  yield ["coffee", 15, between(0, 59), cups];
  // Reading: most evenings, more at weekends and in winter
  if (r() < 0.7)
    yield ["reading", 22, between(0, 59), Math.round(between(10, 40) * (wd % 6 === 0 ? 1.6 : 1) * (1.3 - 0.4 * s))];
}

/**
 * A year of logs up to `end` (a Date), none after it. Metrics as {id, name, type, created, mode?, gran?, u}, entries
 * as this device keeps them: {id, m, y, t, v, u}.
 */
export function demoData(end) {
  const first = new Date(end.getFullYear() - 1, end.getMonth(), end.getDate());
  const days = Math.round((end - first) / 864e5) + 1;
  const last = at(end, end.getHours(), end.getMinutes());
  const r = rng(20261108);
  let u = end.getTime() - 400 * 864e5;
  const metrics = DEMO_METRICS.map((m) => ({ created: at(first, 8, 0), ...m, u: u++ }));
  const entries = [];
  for (let d = new Date(first), i = 0; i < days; d.setDate(d.getDate() + 1), i++)
    for (const [m, h, min, v] of day(d, i, days, r)) {
      const t = at(d, h, min);
      if (t <= last) entries.push({ id: `${m}.${t}`, m, y: d.getFullYear(), t, v, u: u++ });
    }
  return { metrics, entries };
}
