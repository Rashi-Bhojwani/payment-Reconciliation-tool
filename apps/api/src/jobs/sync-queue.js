// Two different things have to be true at once for SP-API work, and one
// generic "is a sync already running?" flag cannot express both:
//
//   1. Two requests that want *the same* sync should share one run. A
//      dashboard load that triggers a background settlement sync while
//      another tab is already doing it must attach to that run, not start a
//      second one.
//   2. Two requests that want *different* work against the same Amazon rate
//      bucket must not overlap. Confirmed live: a double-clicked Settlement
//      "Reset & Resync" launched two settlement syncs ~32s apart, they
//      competed for the reports:document bucket (45s per request), and every
//      document download died with six consecutive 429s:
//        "gave up after 6 attempts: 429 (waited 2000ms) ... 429 (waited 64000ms)"
//        "failed after 248215ms: SP-API request failed after retries"
//      Joining the first run would be wrong here - the second click asks for
//      a *fresh* delete-and-refetch, and silently returning the first run's
//      result would report a reset that never happened for that request.
//      Queueing behind it is the only answer that is both truthful and safe
//      for the rate bucket.
//
// So a task declares a `resourceKey` (the thing that must be serialised - the
// tenant+report type sharing one Amazon bucket) and a `dedupeKey` (the
// identical request that may be shared). Same dedupeKey => one run. Different
// dedupeKey, same resourceKey => strictly one after the other.
export function createSyncQueue() {
  /** resourceKey -> the last task queued for it (the tail to wait behind) */
  const tails = new Map();
  /** dedupeKey -> the in-flight task callers may join */
  const inFlight = new Map();

  return {
    /**
     * @param {object} params
     * @param {string} params.resourceKey Serialisation domain (e.g. `${tenantId}:${reportType}`).
     * @param {string} [params.dedupeKey] Requests sharing this key share one run. Defaults to resourceKey.
     * @param {boolean} [params.queue] When true, wait for other work on resourceKey instead of joining it.
     * @param {() => Promise<any>} params.start
     */
    run({ resourceKey, dedupeKey = resourceKey, queue = false, start }) {
      const existing = inFlight.get(dedupeKey);
      if (existing) return existing;
      if (!queue && tails.has(resourceKey)) return tails.get(resourceKey);

      const previous = tails.get(resourceKey);
      // With nothing to wait for, `start` is invoked synchronously (inside an
      // async wrapper, so a synchronous throw still surfaces as a rejection)
      // rather than deferred to a microtask - the sync must be genuinely
      // under way by the time this returns, not merely scheduled.
      // Swallowing the predecessor's rejection only stops a failed run from
      // cancelling the work queued behind it; its own caller still sees the
      // error.
      const task = (previous ? previous.then(() => undefined, () => undefined).then(start) : (async () => start())())
        .finally(() => {
          if (inFlight.get(dedupeKey) === task) inFlight.delete(dedupeKey);
          // Identity check, not an unconditional delete: by the time a long
          // sync settles, a queued task may already own the tail slot, and
          // clearing it would let a third request start concurrently with it.
          if (tails.get(resourceKey) === task) tails.delete(resourceKey);
        });

      inFlight.set(dedupeKey, task);
      tails.set(resourceKey, task);
      return task;
    },

    /** @param {string} resourceKey */
    isBusy(resourceKey) {
      return tails.has(resourceKey);
    }
  };
}

// The rows come straight back from `delete ... returning *`, so their keys are
// exactly the table's columns and their values are already in the shapes
// node-postgres round-trips (jsonb as an object it re-serialises, timestamptz
// as a Date, numeric as a string). Rebuilt as multi-row INSERTs, chunked to
// stay clear of Postgres's 65535-bound parameter limit.
export function buildRestoreStatements(rows, { table = 'settlement_rows', maxParameters = 60000 } = {}) {
  if (!rows.length) return [];
  const columns = Object.keys(rows[0]);
  if (!columns.length) return [];
  const rowsPerStatement = Math.max(1, Math.floor(maxParameters / columns.length));
  const columnList = columns.map(column => `"${column}"`).join(',');
  const statements = [];
  for (let index = 0; index < rows.length; index += rowsPerStatement) {
    const chunk = rows.slice(index, index + rowsPerStatement);
    const values = [];
    const tuples = chunk.map(row => `(${columns.map(column => {
      values.push(row[column] ?? null);
      return `$${values.length}`;
    }).join(',')})`);
    // `do nothing` with no conflict target: anything the re-fetch already
    // brought back is the authoritative copy and must win over the snapshot.
    statements.push({ text: `insert into ${table} (${columnList}) values ${tuples.join(',')} on conflict do nothing`, values });
  }
  return statements;
}
