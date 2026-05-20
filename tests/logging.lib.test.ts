import { describe, it, expect } from 'vitest'
import {
  LOG_FILENAME_PATTERN,
  LOG_MAX_AGE_DAYS,
  formatLogFileName,
  parseLogFileName,
  findStaleLogFiles,
} from '../src/main/logging.lib'

// ── formatLogFileName ───────────────────────────────────────────────────────

describe('formatLogFileName', () => {
  it('formats a typical date as main-YYYY-MM-DD.log', () => {
    expect(formatLogFileName(new Date(2026, 4, 18))).toBe('main-2026-05-18.log')
  })

  it('zero-pads single-digit months and days', () => {
    expect(formatLogFileName(new Date(2026, 0, 5))).toBe('main-2026-01-05.log')
  })

  it('uses local-time fields (not UTC)', () => {
    // 23:55 local on the 18th — UTC may be on the 19th or 17th depending on TZ,
    // but the local-time fields ARE the 18th.  formatLogFileName must use
    // local-time to keep the file name aligned with the driver's experience.
    const d = new Date(2026, 4, 18, 23, 55)
    expect(formatLogFileName(d)).toBe('main-2026-05-18.log')
  })

  it('round-trips through parseLogFileName', () => {
    const original = new Date(2026, 4, 18)
    const name = formatLogFileName(original)
    const parsed = parseLogFileName(name)
    expect(parsed).toEqual(original)
  })
})

// ── parseLogFileName ────────────────────────────────────────────────────────

describe('parseLogFileName', () => {
  it('returns a Date for a well-formed filename', () => {
    const d = parseLogFileName('main-2026-05-18.log')
    expect(d).toEqual(new Date(2026, 4, 18))
  })

  it('returns null for filenames without the main- prefix', () => {
    expect(parseLogFileName('renderer-2026-05-18.log')).toBeNull()
    expect(parseLogFileName('2026-05-18.log')).toBeNull()
    expect(parseLogFileName('app-2026-05-18.log')).toBeNull()
  })

  it('returns null for filenames without the .log suffix', () => {
    expect(parseLogFileName('main-2026-05-18.txt')).toBeNull()
    expect(parseLogFileName('main-2026-05-18')).toBeNull()
    expect(parseLogFileName('main-2026-05-18.log.tmp')).toBeNull()
  })

  it('returns null when the date components are not zero-padded', () => {
    // The regex requires exactly two digits for month/day, so unpadded values
    // are rejected at the pattern stage — defensive against future code that
    // might format without zero-padding.
    expect(parseLogFileName('main-2026-5-18.log')).toBeNull()
    expect(parseLogFileName('main-2026-05-8.log')).toBeNull()
  })

  it('returns null for impossible dates (Feb 30, month 13)', () => {
    // `new Date(2026, 1, 30)` wraps to March 2; we sanity-check by reading
    // the components back out, so wrapped dates are rejected.
    expect(parseLogFileName('main-2026-02-30.log')).toBeNull()
    expect(parseLogFileName('main-2026-13-01.log')).toBeNull()
    expect(parseLogFileName('main-2026-00-15.log')).toBeNull()
    expect(parseLogFileName('main-2026-05-00.log')).toBeNull()
  })

  it('accepts Feb 29 in a leap year and rejects it in a non-leap year', () => {
    expect(parseLogFileName('main-2028-02-29.log')).toEqual(new Date(2028, 1, 29))
    expect(parseLogFileName('main-2026-02-29.log')).toBeNull()
  })

  it('returns null for empty / random strings', () => {
    expect(parseLogFileName('')).toBeNull()
    expect(parseLogFileName('garbage')).toBeNull()
    expect(parseLogFileName('main-.log')).toBeNull()
  })
})

// ── LOG_FILENAME_PATTERN ────────────────────────────────────────────────────

describe('LOG_FILENAME_PATTERN', () => {
  it('matches the canonical filename shape', () => {
    expect(LOG_FILENAME_PATTERN.test('main-2026-05-18.log')).toBe(true)
  })

  it('is anchored (does not match substring matches)', () => {
    // Defensive: shouldn't match `prefix-main-2026-05-18.log` or
    // `main-2026-05-18.log.archived` partials.
    expect(LOG_FILENAME_PATTERN.test('prefix-main-2026-05-18.log')).toBe(false)
    expect(LOG_FILENAME_PATTERN.test('main-2026-05-18.log.archived')).toBe(false)
  })
})

// ── findStaleLogFiles ───────────────────────────────────────────────────────

describe('findStaleLogFiles', () => {
  // Pin "now" so every test sees the same reference point regardless of when
  // the suite runs.  All age math is relative to this.
  const NOW = new Date(2026, 4, 18, 12, 0, 0) // 2026-05-18T12:00 local

  it('returns nothing when no files are older than the threshold', () => {
    const result = findStaleLogFiles(
      [
        'main-2026-05-18.log',
        'main-2026-05-17.log',
        'main-2026-04-19.log', // 29 days old
      ],
      NOW,
      LOG_MAX_AGE_DAYS,
    )
    expect(result).toEqual([])
  })

  it('returns files strictly older than the threshold', () => {
    const result = findStaleLogFiles(
      [
        'main-2026-04-17.log', // 31 days old — stale
        'main-2026-04-18.log', // exactly 30 days, 0h — NOT stale (boundary)
        'main-2026-04-19.log', // 29 days old — fresh
      ],
      NOW,
      LOG_MAX_AGE_DAYS,
    )
    expect(result).toEqual(['main-2026-04-17.log'])
  })

  it('boundary: file is NOT stale at exactly maxAgeDays', () => {
    // Strictly older-than — at exactly 30.0 days old, keep the file.  This
    // avoids spurious deletes for users in time zones that nudge the
    // comparison by a few hours.
    const file = `main-${formatYmd(addDays(NOW, -30))}.log`
    expect(findStaleLogFiles([file], NOW, 30)).toEqual([])
  })

  it('boundary: file IS stale just past maxAgeDays', () => {
    // 30 days and 13 hours old — past the cutoff.
    const file = `main-${formatYmd(addDays(NOW, -31))}.log`
    expect(findStaleLogFiles([file], NOW, 30)).toEqual([file])
  })

  it('ignores files that do not match the pattern', () => {
    // No matter how old the implied date looks, non-matching files are
    // never returned — the caller deletes only what we hand back, so the
    // logs folder can hold unrelated files safely (e.g. user-override
    // sidecar files, archived hand-zips).
    const result = findStaleLogFiles(
      [
        'main-2020-01-01.log.archived', // wrong suffix
        'renderer-2020-01-01.log',      // wrong prefix
        'crash-2020-01-01.log',         // wrong prefix
        'log-level.json',               // unrelated sidecar
        'README.txt',                   // random
      ],
      NOW,
      LOG_MAX_AGE_DAYS,
    )
    expect(result).toEqual([])
  })

  it('ignores parseable-pattern names with impossible dates', () => {
    // `main-2026-02-30.log` matches the regex but the date is invalid —
    // parseLogFileName returns null, so it never enters age math.
    const result = findStaleLogFiles(
      ['main-2026-02-30.log', 'main-2026-13-01.log'],
      NOW,
      LOG_MAX_AGE_DAYS,
    )
    expect(result).toEqual([])
  })

  it('handles an empty input', () => {
    expect(findStaleLogFiles([], NOW, LOG_MAX_AGE_DAYS)).toEqual([])
  })

  it('returns multiple stale files preserving input order', () => {
    const result = findStaleLogFiles(
      [
        'main-2026-05-17.log', // fresh
        'main-2025-12-01.log', // very stale
        'main-2026-04-01.log', // ~47 days stale
        'main-2026-05-18.log', // fresh (today)
      ],
      NOW,
      LOG_MAX_AGE_DAYS,
    )
    expect(result).toEqual(['main-2025-12-01.log', 'main-2026-04-01.log'])
  })

  it('respects a custom maxAgeDays threshold', () => {
    // Same fixture as above but with a 7-day window — much more aggressive.
    const result = findStaleLogFiles(
      [
        'main-2026-05-17.log', // 1 day — fresh
        'main-2026-05-10.log', // exactly 8 days — stale
        'main-2026-05-11.log', // exactly 7 days — boundary, NOT stale
      ],
      NOW,
      7,
    )
    expect(result).toEqual(['main-2026-05-10.log'])
  })

  it('LOG_MAX_AGE_DAYS is the default when threshold is omitted', () => {
    // Sanity check that the public constant matches the default arg —
    // catches a future drift between the two values.
    const file = `main-${formatYmd(addDays(NOW, -(LOG_MAX_AGE_DAYS + 1)))}.log`
    expect(findStaleLogFiles([file], NOW)).toEqual([file])
  })
})

// ── Test helpers ────────────────────────────────────────────────────────────

function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + days)
  return r
}

function formatYmd(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, '0')
  const mm   = (d.getMonth() + 1).toString().padStart(2, '0')
  const dd   = d.getDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
