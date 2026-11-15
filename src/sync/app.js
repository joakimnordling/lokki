// Lokki's settings for the shared sync code (packages/sync): its name, its two kinds of record and which version of
// one to keep (merge.js). The name is in every key label and every text bound into the encryption, as "lokki/...".
import { mergeRecords } from "./merge.js";

export const LOKKI = { name: "lokki", kinds: ["entry", "metric"], merge: mergeRecords };
