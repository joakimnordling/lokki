/* Lokki backup format: JSON Lines. Every line has a "kind":
     {"kind":"header","format":"lokki","version":1,"exported":"<UTC ISO time>","app":"lokki-web"}   required first line
     {"kind":"metric","id","name","type","mode","gran","created","u","g","deleted"}                 deleted metrics: name etc. null
     {"kind":"entry","id","metric","t","v","n","u","d"}                                             deleted entries: t, v, n null
     {"kind":"footer"}                                                                                required last line
   Lines of unknown kinds are skipped. A file that doesn't end with the footer line is refused. */
import { parseLocal } from "./format.js";
import { normName } from "./names.js";

export const BACKUP_VERSION = 1;
const okId = (x) => typeof x === "string" && /^[A-Za-z0-9_\-.:@+]{1,200}$/.test(x); // usable as a database key
const okT = (x) =>
  typeof x === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(x) && !Number.isNaN(+parseLocal(x));

export function parseBackup(text) {
  const no = (m) => ({ error: m });
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const json = (l) => {
    try {
      return JSON.parse(l);
    } catch (_e) {
      return null;
    }
  };
  const h = json(lines[0] || "");
  if (h?.kind !== "header" || h.format !== "lokki") return no("This isn't a Lokki backup.");
  if (!Number.isInteger(h.version) || h.version < 1) return no("This backup's header is damaged.");
  if (h.version > BACKUP_VERSION) return no("This backup was made by a newer version of Lokki.");
  const f = lines.length > 1 ? json(lines[lines.length - 1]) : null;
  if (f?.kind !== "footer")
    return no('This backup is incomplete: it doesn\'t end with the {"kind":"footer"} line. Nothing was restored.');
  const ms = new Map(),
    es = new Map();
  for (let i = 1; i < lines.length - 1; i++) {
    const o = json(lines[i]);
    const bad = (what) => no(`Line ${i + 1} isn't a valid ${what}. Nothing was restored.`);
    if (!o || typeof o !== "object") return bad("line");
    if (o.kind === "metric") {
      if (!okId(o.id) || !Number.isFinite(o.u) || (!o.deleted && !normName(o.name))) return bad("metric");
      if (o.g !== undefined && !Number.isFinite(o.g)) return bad("metric");
      ms.set(o.id, o);
    } else if (o.kind === "entry") {
      if (!okId(o.id) || !okId(o.metric) || !Number.isFinite(o.u) || (!o.d && !(okT(o.t) && Number.isFinite(o.v))))
        return bad("entry");
      es.set(o.id, o);
    } else if (o.kind === "header" || o.kind === "footer") return bad("line here");
  }
  return { header: h, metrics: ms, entries: es };
}
