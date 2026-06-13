/**
 * Envelope tolerance for the ported clients.
 *
 * The Cumulant backend wraps most product responses in `{ ok: true, data }`,
 * while the ported (originally Arc) clients were written to read the payload
 * directly (Cumulant returned raw JSON for these product endpoints). `unwrap`
 * accepts BOTH: if the value is an `{ ok: true, data }` envelope it returns
 * `data`; otherwise it passes the value through unchanged (raw responses, bare
 * arrays, and the distribution routes' raw JSON all flow through untouched).
 */
export function unwrap<T = unknown>(j: unknown): T {
  if (
    j &&
    typeof j === "object" &&
    !Array.isArray(j) &&
    (j as { ok?: unknown }).ok === true &&
    "data" in (j as object)
  ) {
    return (j as { data: T }).data;
  }
  return j as T;
}
