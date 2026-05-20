// Pure helpers for the log rotation + prune pipeline (#72).
//
// Everything in this file is filesystem-free and electron-free so the prune
// logic can be unit-tested directly from `tests/logging.lib.test.ts`.
//
// The impure orchestrator (readdir + unlink + reading the system clock) lives
// in `logging.ts`, which imports from here.

/** Filename pattern for a date-stamped main-process log file.
 *  Anchored so we don't match `main-2026-05-18.log.tmp` or other partial
 *  collisions; the date capture group is intentionally non-strict (the real
 *  date validation happens in `parseLogFileName`'s `Date` parse). */
export const LOG_FILENAME_PATTERN = /^main-(\d{4}-\d{2}-\d{2})\.log$/

/** How many days of log history we keep before pruning.  Picked to balance
 *  "long enough to be useful for post-mortem after a multi-day issue" against
 *  "doesn't accumulate forever on a daily-driver install."  Tunable. */
export const LOG_MAX_AGE_DAYS = 30

/** Number of milliseconds in a day — used by `findStaleLogFiles` for the
 *  age comparison.  Pulled out as a constant so the math reads cleanly. */
const MS_PER_DAY = 86_400_000

/** Truncate a `Date` to local-time midnight of the same calendar day.  Used
 *  by `findStaleLogFiles` so age is measured in whole-day deltas rather
 *  than wall-clock hours — a file is "30 days old" the day its date is
 *  30 calendar days behind today, regardless of what time you happen to
 *  check.  Calendar-day semantics are what users intuitively expect from
 *  "anything older than 30 days." */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * Format a `Date` as the on-disk log filename for that day's writes.
 * Example: `2026-05-18` → `main-2026-05-18.log`.
 *
 * Uses local-time `getFullYear/Month/Date` (not UTC) so a session that
 * starts at 11:55 PM PT writes to the *PT-day's* file rather than jumping
 * to the next day's file because UTC has already rolled over.  The driver
 * cares about "what time was it for me when this line was logged."
 */
export function formatLogFileName(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, '0')
  const mm   = (d.getMonth() + 1).toString().padStart(2, '0')
  const dd   = d.getDate().toString().padStart(2, '0')
  return `main-${yyyy}-${mm}-${dd}.log`
}

/**
 * Parse a log filename back into a `Date` (set to local-time midnight of the
 * file's day).  Returns `null` if the name doesn't match the expected shape
 * OR if the captured y/m/d values don't form a real calendar date (e.g.
 * `main-2026-02-31.log` → null, `main-2026-13-01.log` → null).
 *
 * Used by `findStaleLogFiles` to compute file ages, but also exported so
 * callers can decide whether a given file in the logs directory is one of
 * ours before doing anything with it.
 */
export function parseLogFileName(name: string): Date | null {
  const m = LOG_FILENAME_PATTERN.exec(name)
  if (!m) return null
  const [y, mo, d] = m[1].split('-').map(Number)
  // `new Date(y, mo-1, d)` wraps invalid components (e.g. month=13 → January
  // of next year), so we sanity-check by reading the components back out.
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null
  }
  return dt
}

/**
 * From a list of filenames in the logs directory, return the subset that
 * matches the `main-YYYY-MM-DD.log` pattern AND is older than `maxAgeDays`
 * relative to `now`.
 *
 *   - Files that don't match the pattern are ignored (the function never
 *     returns them — caller deletes only what we hand back, so unknown
 *     files in the directory stay untouched).
 *   - Files whose date parses but is exactly `maxAgeDays` days old are NOT
 *     considered stale — boundary is strictly older-than.  This matters at
 *     the cutover edge: on day 30 the day-30 file becomes stale; we'd
 *     rather wait one extra day than risk deleting "today − 30" prematurely
 *     for users in time zones that shift the comparison.
 *   - The `now` parameter is injectable so the test suite can pin the
 *     clock; production wires it to `new Date()`.
 *
 * Pure function: no IO, no system clock reads.
 */
export function findStaleLogFiles(
  filenames: readonly string[],
  now: Date,
  maxAgeDays: number = LOG_MAX_AGE_DAYS,
): string[] {
  // Truncate `now` to midnight so age math compares calendar-day deltas,
  // not wall-clock hours.  Without this, running the prune at noon would
  // see today-minus-30-days as "30.5 days old" and delete it half a day
  // earlier than running at midnight would — confusing and TZ-fragile.
  const nowDay = startOfDay(now).getTime()
  const stale: string[] = []
  for (const name of filenames) {
    const d = parseLogFileName(name)
    if (!d) continue
    // Both nowDay and d are midnight-aligned, so the delta is an integer
    // number of days when DST hasn't shifted between the two points.  DST
    // shifts can push this by ±1h, which doesn't change the integer day
    // count once we floor — explicit floor is defensive against that.
    const ageDays = Math.floor((nowDay - d.getTime()) / MS_PER_DAY)
    if (ageDays > maxAgeDays) stale.push(name)
  }
  return stale
}
