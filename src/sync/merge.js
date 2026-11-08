// Which version of a record wins (docs/sync-protocol.md, section 6). Positive: a wins; negative: b wins; 0: the same.

const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

/** Entries: the newer u; the same u: the greater JSON of [u, deleted, t, v, n]. */
export function compareEntries(a, b) {
  return (
    cmp(a.u, b.u) ||
    cmp(
      JSON.stringify([a.u, a.d ? 1 : 0, a.t || "", a.v ?? "", a.n || ""]),
      JSON.stringify([b.u, b.d ? 1 : 0, b.t || "", b.v ?? "", b.n || ""]),
    )
  );
}

/** Metrics: the greater generation g; then live beats deleted; then the newer u; then the text fields. */
export function compareMetrics(a, b) {
  return (
    cmp(a.g || 0, b.g || 0) ||
    cmp(a.deleted ? 0 : 1, b.deleted ? 0 : 1) ||
    cmp(a.u, b.u) ||
    cmp(
      JSON.stringify([a.name || "", a.type || "", a.created || ""]),
      JSON.stringify([b.name || "", b.type || "", b.created || ""]),
    )
  );
}

export const compareRecords = (a, b) => (a.kind === "metric" ? compareMetrics(a, b) : compareEntries(a, b));
