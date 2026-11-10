// The icons Lokki uses, by role. The markup comes from Lucide via the generated lucide.js (npm run icons).
import { LUCIDE } from "./lucide.js";

export const TYPES = [
  "Diet",
  "Fitness",
  "Games",
  "Outdoors",
  "Pets",
  "Shopping",
  "Grades",
  "Health",
  "Hobbies",
  "Social",
  "Sports",
  "Travel",
  "Life",
  "Medical",
  "Music",
  "Wealth",
  "Work",
];
// Inner markup of the icon for each log type ("" = no type).
export const TYPE_ICON = Object.fromEntries(
  Object.entries({
    "": "trending-up",
    Diet: "utensils",
    Fitness: "dumbbell",
    Games: "gamepad-2",
    Outdoors: "mountain-snow",
    Pets: "cat",
    Shopping: "shopping-cart",
    Grades: "graduation-cap",
    Health: "heart",
    Hobbies: "camera",
    Social: "martini",
    Sports: "volleyball",
    Travel: "luggage",
    Life: "user",
    Medical: "stethoscope",
    Music: "music",
    Wealth: "circle-dollar-sign",
    Work: "monitor",
  }).map(([type, name]) => [type, LUCIDE[name]]),
);

// A complete <svg> for an icon; extra attributes as a string.
export const svg = (name, attrs = "") => `<svg viewBox="0 0 24 24"${attrs}>${LUCIDE[name]}</svg>`;
export const ICON = {
  grid: svg("grip"),
  gear: svg("settings"),
  back: svg("chevron-left", ' style="width:24px"'),
  edit: svg("square-pen"),
  r: svg("chevron-right"),
  chev: svg("chevron-right", ' class="chev"'),
  csv: svg("arrow-down-up", ' aria-hidden="true"'),
  add: svg("plus", ' aria-hidden="true"'),
  trash: svg("trash-2", ' aria-hidden="true"'),
  synced: svg("cloud-check", ' aria-hidden="true"'),
  sending: svg("cloud-upload", ' aria-hidden="true"'),
  offline: svg("cloud-off", ' aria-hidden="true"'),
  failing: svg("cloud-alert", ' aria-hidden="true"'),
  syncing: svg("refresh-cw", ' aria-hidden="true"'),
};
