// Pit Strategy — pure logic.
// Anything below is React-free and side-effect-free so it can be unit-tested
// directly from `tests/`.  The component (`index.tsx`) is a thin shell that
// owns one `useRef` of `PitTrackerState`, pipes each telemetry tick through
// `reducePitTracker()`, and renders the output of the derived-stats helpers.

import type { SessionType } from '../../types/telemetry'

/** Last-resort lap-time when we have no lap data at all (lap 1 of session). */
export const LAP_TIME_ESTIMATE = 92

/** Minimum fuelUsePerHour (L/hr) below which the engine is assumed to be idling
 *  rather than driving.  At idle the SDK reports ~1–2 L/hr which would yield
 *  absurd laps-remaining values if used as a per-lap proxy. */
export const MIN_DRIVING_FUEL_RATE = 5

/** Maximum prior-laps in the trend window — "vs LAST 3" is the target. */
export const TREND_WINDOW = 3

/** Max samples retained in the rolling per-lap fuel buffer. */
export const FUEL_SAMPLE_WINDOW = 5

/** Max laps retained in the rolling lap-history buffer. */
export const LAP_HISTORY_WINDOW = 30

/** Lower / upper sanity bounds on a single per-lap fuel sample, in litres.
 *  Anything outside this range usually indicates a refuel mid-lap, a missed
 *  lap-boundary tick, or otherwise stale telemetry — discard it. */
export const FUEL_SAMPLE_MIN = 0.05
export const FUEL_SAMPLE_MAX = 15

/** One completed lap.  `pitAffected = true` means the player was on pit road
 *  at any point during this lap (out-lap, in-lap, or a full pit stop), so the
 *  lap time isn't representative of tire wear and the lap is excluded from the
 *  current stint. */
export interface LapRecord {
  lap: number
  time: number
  pitAffected: boolean
}

export interface StintMetrics {
  /** Contiguous clean laps since the most recent pit-affected lap. */
  currentStint: LapRecord[]
  /** Most recent lap in the current stint, or null if the stint is empty. */
  lastLap: LapRecord | null
  /** Fastest lap of the current stint, or null if the stint is empty. */
  stintBest: LapRecord | null
  /** lastLap.time − avg(up-to-3 prior stint laps).  Null when no prior laps. */
  trendDelta: number | null
  /** True once the trend window has 3 prior samples (s4+ of the stint). */
  trendMature: boolean
  /** Number of prior laps included in the trend (0, 1, 2, or 3). */
  priorCount: number
  /** lastLap.time − stintBest.time.  Always ≥ 0; null when the stint is empty. */
  stintBestDelta: number | null
}

/**
 * Format a lap time in seconds as `M:SS.mmm` (e.g. `1:32.456`).
 * Returns `--:--.---` for non-positive inputs (no valid lap yet).
 */
export function formatLapTime(s: number): string {
  if (s <= 0) return '--:--.---'
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(3).padStart(6, '0')
  return `${m}:${sec}`
}

/**
 * Compute stint-scoped tire-deg metrics from the player's lap history.
 *
 * A "stint" is the contiguous run of clean flying laps since the most recent
 * pit-affected lap.  Session-best is deliberately not referenced — a fresh-tire
 * run an hour ago tells us nothing about the current set.
 *
 * Returned numbers:
 *   - `trendDelta`     — lastLap vs avg of up-to-3 prior stint laps (directional)
 *   - `stintBestDelta` — lastLap vs stintBest (always ≥ 0)
 *
 * Pure function: no refs, no state, no React.
 */
export function computeStintMetrics(lapHistory: LapRecord[]): StintMetrics {
  // Walk backwards from the end; everything after the last pit-affected lap
  // is the current stint.
  const currentStint: LapRecord[] = []
  for (let i = lapHistory.length - 1; i >= 0; i--) {
    if (lapHistory[i].pitAffected) break
    currentStint.unshift(lapHistory[i])
  }

  const lastLap = currentStint.length > 0 ? currentStint[currentStint.length - 1] : null

  const stintBest =
    currentStint.length > 0
      ? currentStint.reduce((best, r) => (r.time < best.time ? r : best))
      : null

  // Up-to-3 laps immediately preceding the last lap (slice(-4, -1) of a stint
  // of length N gives the prior min(3, N-1) laps).
  const priorLaps = currentStint.slice(-(TREND_WINDOW + 1), -1)
  const trendDelta =
    lastLap && priorLaps.length > 0
      ? lastLap.time - priorLaps.reduce((s, r) => s + r.time, 0) / priorLaps.length
      : null
  const trendMature = priorLaps.length >= TREND_WINDOW

  const stintBestDelta = lastLap && stintBest ? lastLap.time - stintBest.time : null

  return {
    currentStint,
    lastLap,
    stintBest,
    trendDelta,
    trendMature,
    priorCount: priorLaps.length,
    stintBestDelta,
  }
}

export interface FuelInputs {
  /** Rolling samples of per-lap consumption (litres), measured at lap boundaries. */
  samples: number[]
  /** Current fuel level (litres). */
  fuelLevel: number
  /** Live SDK `FuelUsePerHour` value (litres/hour). */
  fuelUsePerHour: number
  /** Current lap number. */
  currentLap: number
  /** Most recent completed lap time (seconds).  0 if unknown. */
  lapLastLapTime: number
  /** Laps left in the current session (`IRacingTelemetry.sessionLapsRemain`).
   *  Values outside `[0, MAX_USABLE_LAPS_REMAIN]` are treated as "not a
   *  usable lap count" — typically because the session is timed and the
   *  leader hasn't seen the checkered yet, so iRacing reports a sentinel
   *  like `-1` or `32767`.  `0` IS usable and means "the race is over for
   *  this car" — see `computeFuelStats` for the special-case handling.
   *  Optional for backward compat with callers that don't yet pipe it through. */
  sessionLapsRemain?: number
  /** iRacing's `SessionState` enum.  Values `>= RACE_OVER_SESSION_STATE`
   *  (Checkered, CoolDown) mean the race is over for the whole field —
   *  `finishOnFuel` latches true on this signal so the headline can't flip
   *  back to "Pit in N laps" if `sessionLapsRemain` reverts post-checkered
   *  (which it can, depending on how iRacing transitions through cool-down).
   *  Optional for backward compat with callers / tests. */
  sessionState?: number
}

/** Lower bound of `SessionState` values that mean "the race is done for the
 *  whole field" — Checkered (5) and CoolDown (6).  Below this is either
 *  pre-race (GetInCar / Warmup / ParadeLaps) or actively racing (Racing = 4);
 *  neither should force the finish-on-fuel affordance on its own. */
export const RACE_OVER_SESSION_STATE = 5

/** Urgency tier for the Pit Window display.  Drives the colour ramp + which
 *  copy variant the UI shows.  See `urgencyFor()` for the threshold math. */
export type PitUrgency =
  | 'finish'   // race ends before fuel runs out — no pit needed for fuel alone
  | 'safe'     // pit is comfortably far away (6+ laps)
  | 'warn'     // pit is approaching (3–5 laps)
  | 'danger'   // pit imminent or overdue (≤ 2 laps)
  | 'unknown'  // no reliable estimate yet

/** Boundaries between urgency tiers, in laps-until-required-pit. */
export const URGENCY_DANGER_THRESHOLD = 3
export const URGENCY_WARN_THRESHOLD   = 6

/** A `sessionLapsRemain` value at or above this is treated as a sentinel
 *  rather than a real lap count.  iRacing reports very large values (often
 *  `32767`) for timed sessions; the upper bound of "this could plausibly
 *  be a real race length" is well below that. */
export const MAX_USABLE_LAPS_REMAIN = 9999

export interface FuelStats {
  /** Estimated per-lap fuel consumption (litres).  0 when no reliable estimate. */
  fuelPerLap: number
  /** Estimated laps remaining on current fuel.  0 when no reliable estimate. */
  lapsOnFuel: number
  /** True when either the rolling samples or live SDK rate produced a useful number. */
  hasReliableEstimate: boolean
  /** Latest lap at which the player should pit, or null when no fuel-forced
   *  pit is needed in this race (race ends before fuel runs out) or when
   *  there's no reliable fuel estimate. */
  pitLap: number | null
  /** Whole laps from `currentLap` until the player must pit, or null when
   *  `pitLap` is null.  Same value as `pitLap - currentLap`, surfaced
   *  separately so the UI can read it without re-doing the math. */
  lapsUntilPit: number | null
  /** True when the race ends before fuel runs out — i.e. the player can
   *  complete the race without pitting for fuel.  Drives the
   *  `urgency: 'finish'` UI variant. */
  finishOnFuel: boolean
  /** Laps remaining in the race when the value is a usable lap count.
   *  `null` when timed / sentinel — i.e. when no race-endpoint awareness
   *  is available.  Surfaced separately so the UI can render context like
   *  "(N laps left)" when appropriate. */
  lapsLeftInRace: number | null
  /** Visual urgency tier; see `PitUrgency`. */
  urgency: PitUrgency
}

/** Map a `lapsUntilPit` value (or null) to an urgency tier.  Pulled out so
 *  the boundary math stays in one place and is unit-testable on its own. */
export function urgencyFor(lapsUntilPit: number | null, finishOnFuel: boolean): PitUrgency {
  if (finishOnFuel) return 'finish'
  if (lapsUntilPit === null) return 'unknown'
  if (lapsUntilPit < URGENCY_DANGER_THRESHOLD) return 'danger'
  if (lapsUntilPit < URGENCY_WARN_THRESHOLD)   return 'warn'
  return 'safe'
}

/** Human-readable countdown label for the Pit Window.  Returns the headline
 *  string that the UI renders large + coloured (e.g. "Pit in 5 laps"); the
 *  absolute `pitLap` is shown in a secondary "by Lap 14" affordance.
 *
 *  Special-cases the two values where a plain "in N laps" reading would be
 *  ambiguous mid-race:
 *    - 0 laps  → "Pit this lap"  (the player is on the pit lap RIGHT NOW;
 *                                 come in at the end of this lap)
 *    - 1 lap   → "Pit next lap"  (the lap after the current one is the
 *                                 pit lap)
 *
 *  Returns `null` when `lapsUntilPit` is unknown (no reliable fuel estimate)
 *  so the caller can render nothing rather than misleading text. */
export function pitCountdownLabel(lapsUntilPit: number | null): string | null {
  if (lapsUntilPit === null) return null
  if (lapsUntilPit === 0) return 'Pit this lap'
  if (lapsUntilPit === 1) return 'Pit next lap'
  return `Pit in ${lapsUntilPit} laps`
}

/**
 * Compute fuel statistics for the Pit Strategy overlay.
 *
 * Priority order for the per-lap consumption estimate:
 *   1. Rolling average of measured per-lap fuel (most accurate).
 *   2. Live `fuelUsePerHour × lapTime` (reasonable while actually driving).
 *   3. No estimate — return zeros so the UI can render `--` instead of garbage.
 *
 * When `sessionLapsRemain` is in the usable range OR `sessionState` is
 * Checkered / CoolDown, the function also computes race-endpoint awareness
 * (#12 / #70): if the race ends before fuel runs out, `pitLap` /
 * `lapsUntilPit` are nulled and `finishOnFuel` is set so the UI shows a
 * green "Finish on fuel" affordance instead of a misleading fuel-forced
 * pit-by lap that's *after* the checkered flag.
 *
 * Pure function: caller is responsible for maintaining the rolling samples ref.
 */
export function computeFuelStats({
  samples,
  fuelLevel,
  fuelUsePerHour,
  currentLap,
  lapLastLapTime,
  sessionLapsRemain,
  sessionState,
}: FuelInputs): FuelStats {
  let fuelPerLap = 0
  let hasReliableEstimate = false

  if (samples.length > 0) {
    fuelPerLap = samples.reduce((a, b) => a + b, 0) / samples.length
    hasReliableEstimate = true
  } else if (fuelUsePerHour > MIN_DRIVING_FUEL_RATE) {
    const lapTime = lapLastLapTime > 0 ? lapLastLapTime : LAP_TIME_ESTIMATE
    fuelPerLap = fuelUsePerHour * (lapTime / 3600)
    hasReliableEstimate = true
  }

  const lapsOnFuel = hasReliableEstimate && fuelPerLap > 0 ? fuelLevel / fuelPerLap : 0

  // Race-endpoint awareness.  `sessionLapsRemain` is only trusted when it's
  // a plausible non-negative integer lap count — timed races emit sentinels
  // (typically `-1` or `32767`) which we deliberately classify as "no info".
  //
  // `0` is accepted because iRacing reports it when this car has crossed the
  // line for the last time in the session — i.e. the race is over for them.
  // See #70: at the start of the final lap of a timed race, `sessionLapsRemain`
  // can transition from `1` to `0` while the player is still rolling, and the
  // old `>= 1` cutoff dropped that tick into "no-info" land — which flipped
  // the headline from green "Finish on fuel" back to "Pit in N laps" using
  // the still-plentiful fuel estimate.
  const lapsLeftInRace =
    typeof sessionLapsRemain === 'number'
      && Number.isFinite(sessionLapsRemain)
      && sessionLapsRemain >= 0
      && sessionLapsRemain <= MAX_USABLE_LAPS_REMAIN
      ? Math.floor(sessionLapsRemain)
      : null

  // SessionState >= 5 (Checkered / CoolDown) is the field-wide "race is over"
  // signal — latch it independently of `sessionLapsRemain`, because iRacing
  // can revert `SessionLapsRemain` to a stale positive integer or sentinel
  // once the cool-down session begins. #70 follow-up: a user observed a
  // 9-lap race where after the checkered the headline flipped from
  // "Finish on fuel" back to "Pit in 9 laps" because SessionLapsRemain
  // resurfaced as ~9 in cool-down.
  const sessionEnded =
    typeof sessionState === 'number'
      && Number.isFinite(sessionState)
      && sessionState >= RACE_OVER_SESSION_STATE

  // `finishOnFuel` is true when ANY of:
  //   - The session has ended for the whole field (`sessionState >= 5`), OR
  //   - The race is already over for this car (`lapsLeftInRace === 0`) —
  //     no pit needed regardless of fuel level, OR
  //   - We have a fuel estimate AND it covers the remaining race laps.
  const finishOnFuel =
    sessionEnded
      || (lapsLeftInRace !== null && (
        lapsLeftInRace === 0
          || (lapsOnFuel > 0 && lapsLeftInRace <= lapsOnFuel)
      ))

  // `pitLap` / `lapsUntilPit` are null when:
  //   - There's no reliable fuel estimate, OR
  //   - The race ends before fuel runs out (no fuel-forced pit needed).
  let pitLap: number | null = null
  let lapsUntilPit: number | null = null
  if (lapsOnFuel > 0 && !finishOnFuel) {
    pitLap       = Math.floor(currentLap + lapsOnFuel - 0.5)
    lapsUntilPit = Math.max(0, pitLap - currentLap)
  }

  const urgency = urgencyFor(lapsUntilPit, finishOnFuel)

  return {
    fuelPerLap,
    lapsOnFuel,
    hasReliableEstimate,
    pitLap,
    lapsUntilPit,
    finishOnFuel,
    lapsLeftInRace,
    urgency,
  }
}

// ── Per-tick state machine ───────────────────────────────────────────────────
// Everything below replaces what used to live as a tangle of `useRef` + two
// `useEffect`s in `index.tsx`.  Pulling it out as a pure reducer lets us:
//   1. Detect session transitions reliably — the previous shape would silently
//      skip its reset branch when `lapLastLapTime` happened to be 0 on the
//      session-change tick (see #39).
//   2. Cover the lap-tracking + fuel-sampling rules with unit tests directly,
//      rather than driving them through React effects.

/** All persistent state for the Pit Strategy tracker, evolving tick by tick. */
export interface PitTrackerState {
  /** All completed laps seen in the current session (capped at LAP_HISTORY_WINDOW). */
  lapHistory: LapRecord[]
  /** Highest lap number already pushed; new laps must have a strictly larger value. */
  lastTrackedLap: number
  /** Sticky-OR'd flag: was the player on pit road at any point during the current lap. */
  wasInPitThisLap: boolean
  /** Fuel level (L) snapshotted at the start of the current lap.  `-1` = not yet bootstrapped. */
  fuelAtLapStart: number
  /** Rolling per-lap fuel samples (L), capped at FUEL_SAMPLE_WINDOW. */
  fuelPerLapSamples: number[]
  /** Last known sessionType; used to detect session transitions (e.g. qualifying → race). */
  prevSessionType: SessionType
}

/** Fresh state.  `wasInPitThisLap` starts true because every session begins
 *  with the player in their pit stall, so lap 1 is an out-lap by definition. */
export const INITIAL_PIT_TRACKER_STATE: PitTrackerState = {
  lapHistory: [],
  lastTrackedLap: 0,
  wasInPitThisLap: true,
  fuelAtLapStart: -1,
  fuelPerLapSamples: [],
  prevSessionType: 'unknown',
}

/** A single telemetry tick fed into `reducePitTracker`. */
export interface PitTrackerTick {
  connected: boolean
  sessionType: SessionType
  lap: number
  /** Most recent completed lap time (seconds).  0 if no lap completed yet. */
  lapLastLapTime: number
  /** Current fuel level (litres). */
  fuelLevel: number
  /** True if the player's car is currently on pit road. */
  playerInPit: boolean
}

/**
 * Advance the Pit Strategy tracker by one telemetry tick.
 *
 * Responsibilities:
 *   - **Session-transition / replay-rewind detection.**  Triggers a clean
 *     slate on either (a) `sessionType` moving between two known values
 *     (e.g. `'qualifying' → 'race'`) or (b) the lap counter going backwards
 *     (e.g. replay rewind, tow-to-pit, mid-session join).  This runs *before*
 *     any other gating — the bug in #39 was that the previous shape
 *     short-circuited on `lapLastLapTime <= 0` and never reached its reset.
 *   - **Sticky pit-affected flag.**  OR's true whenever the player is on pit
 *     road; cleared on each lap boundary.  A pit visit early in a lap
 *     correctly taints the whole lap even if the player has rejoined the
 *     racing surface by the time it completes.
 *   - **Lap-boundary detection.**  When the lap counter advances and iRacing
 *     reports a non-zero `lapLastLapTime`, push a new `LapRecord` carrying
 *     the current pit-flag, then reset that flag.  Tolerates a tick of delay
 *     in `lapLastLapTime` — we only advance `lastTrackedLap` once we've
 *     actually pushed the record.
 *   - **Fuel sampling.**  On the same lap boundary, push a per-lap fuel-
 *     consumed sample, sanity-gated to `[FUEL_SAMPLE_MIN, FUEL_SAMPLE_MAX]`.
 *     Refuels (negative consumed) and obviously stale samples are dropped.
 *
 * Pure: no side effects, no refs, no React.
 */
export function reducePitTracker(state: PitTrackerState, tick: PitTrackerTick): PitTrackerState {
  if (!tick.connected) return state

  // ── 1. Session-transition / replay-rewind reset ─────────────────────────────
  // sessionType moving between two *known* values is the strongest signal.
  // Lap counter going backwards is the fallback — covers replay rewinds and
  // any case where sessionType lags behind the lap counter.
  const sessionChanged =
    tick.sessionType !== state.prevSessionType &&
    state.prevSessionType !== 'unknown' &&
    tick.sessionType !== 'unknown'
  const lapWentBackwards = tick.lap < state.lastTrackedLap

  if (sessionChanged || lapWentBackwards) {
    return {
      ...INITIAL_PIT_TRACKER_STATE,
      prevSessionType: tick.sessionType,
    }
  }

  let next = state

  // Track the latest known sessionType so an eventual `unknown → known`
  // transition doesn't get mistaken for a real session change.
  if (tick.sessionType !== state.prevSessionType) {
    next = { ...next, prevSessionType: tick.sessionType }
  }

  // ── 2. Sticky pit-affected flag ─────────────────────────────────────────────
  if (tick.playerInPit && !next.wasInPitThisLap) {
    next = { ...next, wasInPitThisLap: true }
  }

  // ── 3. Lap boundary ─────────────────────────────────────────────────────────
  // Push only when the counter has truly advanced AND iRacing has reported a
  // non-zero lap time.  Lap counters start at 1 the moment a session goes live
  // (no lap completed yet), so we require `tick.lap > 1` to push anything.
  const lapAdvanced = tick.lap > next.lastTrackedLap && tick.lap > 1
  if (lapAdvanced && tick.lapLastLapTime > 0) {
    const newRecord: LapRecord = {
      lap: tick.lap - 1,
      time: tick.lapLastLapTime,
      pitAffected: next.wasInPitThisLap,
    }
    const lapHistory = [...next.lapHistory, newRecord]
    if (lapHistory.length > LAP_HISTORY_WINDOW) lapHistory.shift()

    // Fuel sample at the same boundary.
    let fuelPerLapSamples = next.fuelPerLapSamples
    if (next.fuelAtLapStart > 0 && tick.fuelLevel > 0) {
      const consumed = next.fuelAtLapStart - tick.fuelLevel
      if (consumed > FUEL_SAMPLE_MIN && consumed < FUEL_SAMPLE_MAX) {
        fuelPerLapSamples = [...fuelPerLapSamples, consumed]
        if (fuelPerLapSamples.length > FUEL_SAMPLE_WINDOW) fuelPerLapSamples.shift()
      }
    }

    next = {
      ...next,
      lapHistory,
      lastTrackedLap: tick.lap,
      wasInPitThisLap: false,
      // Snapshot the new lap's starting fuel level.  Fall back to whatever we
      // had if the SDK briefly reports 0 (paused / out of car / etc.).
      fuelAtLapStart: tick.fuelLevel > 0 ? tick.fuelLevel : next.fuelAtLapStart,
      fuelPerLapSamples,
    }
  } else if (next.fuelAtLapStart < 0 && tick.fuelLevel > 0) {
    // ── 4. Bootstrap ──────────────────────────────────────────────────────────
    // First time we see a positive fuel level, snapshot it so the next lap
    // boundary has a baseline to subtract from.
    next = { ...next, fuelAtLapStart: tick.fuelLevel }
  }

  return next
}
