/* Ready-made metrics to start from (Create Metric → Suggestions), by log type. Each starts in the chart view that
   suits it best while it has only a few entries: most things you do on some days and not others show as daily
   totals, so two entries on two days already make two bars; things you measure (weight, blood pressure) show every
   value, so the second one already draws a line. The view is only where a metric starts: its pills change it. */

/** [type, [[name, mode, gran], ...]], in the order they're listed. */
export const SUGGESTIONS = [
  [
    "Fitness",
    [
      ["Running", "totals", "daily"],
      ["Walking", "totals", "daily"],
      ["Cycling", "totals", "daily"],
      ["Swimming", "totals", "daily"],
      ["Pushups", "totals", "daily"],
      ["Squats", "totals", "daily"],
      ["Workout Minutes", "totals", "daily"],
    ],
  ],
  [
    "Health",
    [
      ["Body Weight", "all", "daily"],
      ["Steps", "totals", "daily"],
      ["Sleep Hours", "avg", "daily"],
      ["Resting Heart Rate", "all", "daily"],
    ],
  ],
  [
    "Medical",
    [
      ["Blood Pressure (Systolic)", "all", "daily"],
      ["Blood Pressure (Diastolic)", "all", "daily"],
      ["Blood Sugar", "all", "daily"],
    ],
  ],
  [
    "Diet",
    [
      ["Water Glasses", "totals", "daily"],
      ["Cups of Coffee", "totals", "daily"],
      ["Calories", "totals", "daily"],
      ["Fruit & Vegetable Portions", "totals", "daily"],
    ],
  ],
  [
    "Hobbies",
    [
      ["Pages Read", "totals", "daily"],
      ["Meditation Minutes", "totals", "daily"],
      ["Instrument Practice Minutes", "totals", "daily"],
    ],
  ],
  [
    "Life",
    [
      ["Mood (1–10)", "all", "daily"],
      ["Screen Time Hours", "totals", "daily"],
    ],
  ],
  ["Work", [["Hours Worked", "totals", "daily"]]],
  ["Wealth", [["Spending", "totals", "daily"]]],
];
