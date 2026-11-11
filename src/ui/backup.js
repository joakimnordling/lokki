// Back Up and Restore from Backup. Backups are saved as a .zip holding one .jsonl file. Restore also reads a plain
// .jsonl and a .jsonl.gz.
import { parseBackup } from "../core/backup-format.js";
import { clock, dayLabel, esc, fileStamp, fmt } from "../core/format.js";
import { normName } from "../core/names.js";
import { pipeBytes, unzipFirst, zipOne } from "../core/zip.js";
import { applyRestore, backupText, planRestore } from "../data/backup.js";
import { fail } from "../data/records.js";
import { $ } from "./dom.js";
import { saveFile } from "./files.js";
import { sheet, toast } from "./sheets.js";

export async function backUp() {
  const day = fileStamp(),
    text = backupText();
  let ok;
  if (typeof CompressionStream === "function") {
    try {
      ok = await saveFile(
        `lokki-backup-${day}.zip`,
        await zipOne(`lokki-backup-${day}.jsonl`, new TextEncoder().encode(text)),
        "Backup",
      );
    } catch (_e) {
      ok = undefined;
    }
  }
  if (ok === undefined) ok = await saveFile(`lokki-backup-${day}.txt`, text, "Backup"); // no compression available: plain JSON Lines as .txt
  if (ok) toast("Backup saved.");
}

export async function restoreFromFile(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const say = (title, msg) => sheet(title, `<p style="line-height:1.5">${esc(msg)}</p>`, { cancel: "Close" });
  let text;
  try {
    const bytes = new Uint8Array(await f.arrayBuffer()),
      zip = bytes[0] === 0x50 && bytes[1] === 0x4b,
      gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if ((zip || gz) && typeof DecompressionStream !== "function")
      return say(
        "Can't Restore",
        "This browser can't open compressed backups. Unpack the file and choose the .jsonl inside.",
      );
    text = new TextDecoder().decode(
      zip ? await unzipFirst(bytes) : gz ? await pipeBytes(bytes, new DecompressionStream("gzip")) : bytes,
    );
  } catch (_e) {
    return say("Can't Restore", "This file couldn't be read. It may be damaged or incomplete. Nothing was restored.");
  }
  const b = parseBackup(text);
  if (b.error) return say("Can't Restore", b.error);
  const p = planRestore(b);
  const inFile = {
    m: [...b.metrics.values()].filter((m) => !m.deleted).length,
    e: [...b.entries.values()].filter((e) => !e.d).length,
    d: [...b.entries.values()].filter((e) => e.d).length,
  };
  const n = (x, one, many) => `${fmt(x)} ${x === 1 ? one : many}`;
  const ch = [
    p.addM.length && n(p.addM.length, "metric added", "metrics added"),
    p.updM.length && n(p.updM.length, "metric updated", "metrics updated"),
    p.delM.length && n(p.delM.length, "metric deleted", "metrics deleted"),
    p.addE.length && n(p.addE.length, "entry added", "entries added"),
    p.updE.length && n(p.updE.length, "entry updated", "entries updated"),
    p.delE.length && n(p.delE.length, "entry deleted", "entries deleted"),
  ].filter(Boolean);
  const bm = p.bringM.map(
      (m) => `${esc(normName(m.name))} (${n(p.bringE.filter((x) => x.metric === m.id).length, "entry", "entries")})`,
    ),
    loose = p.bringE.filter((x) => !x.metric).length;
  const bringTxt = [...bm, loose && `${n(loose, "entry", "entries")}${bm.length ? " in other metrics" : ""}`]
    .filter(Boolean)
    .join(", ");
  const when = (h) => {
    const d = new Date(h.exported);
    return Number.isNaN(+d) ? "" : `Exported ${dayLabel(+d)} ${clock(+d)}. `;
  };
  const nothing = !ch.length && !bringTxt;
  sheet(
    "Restore from Backup",
    `<p style="line-height:1.5">${when(b.header)}The backup has ${n(inFile.m, "metric", "metrics")}, ${n(inFile.e, "entry", "entries")} and ${n(inFile.d, "deleted entry", "deleted entries")}.</p>
    <p style="line-height:1.5">${nothing ? "Nothing to change: the app already has everything in this backup." : ch.length ? `<b>Changes here:</b> ${ch.join(", ")}. Nothing newer will be overwritten.` : "No other changes."}</p>
    ${bringTxt ? `<label class="setrow" style="gap:12px;cursor:pointer"><span>Bring back what you've deleted since<small>${bringTxt}</small></span><input type="checkbox" id="rBring" style="width:22px;height:22px;accent-color:var(--accent)"></label>` : ""}`,
    nothing
      ? { cancel: "Close" }
      : {
          doneLabel: "Restore",
          done: () => {
            const bring = !!$("#rBring")?.checked;
            if (!ch.length && !bring) {
              toast("Nothing restored.");
              return;
            }
            applyRestore(p, bring)
              .then((r) =>
                toast(`Restored: ${n(r.metrics, "metric", "metrics")}, ${n(r.entries, "entry", "entries")} changed`),
              )
              .catch((e) => fail(e));
          },
        },
  );
}
