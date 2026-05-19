import { describe, it, expect } from 'vitest'
import {
  type LapRecord,
  type PitTrackerState,
  type PitTrackerTick,
  formatLapTime,
  computeStintMetrics,
  computeFuelStats,
  reducePitTracker,
  urgencyFor,
  pitCountdownLabel,
  INITIAL_PIT_TRACKER_STATE,
  LAP_TIME_ESTIMATE,
  MIN_DRIVING_FUEL_RATE,
  LAP_HISTORY_WINDOW,
  FUEL_SAMPLE_WINDOW,
  URGENCY_DANGER_THRESHOLD,
  URGENCY_WARN_THRESHOLD,
  MAX_USABLE_LAPS_REMAIN,
} from '../src/renderer/src/overlays/PitStrategy/lib'

// Helper: shorthand to build a lap record.
const lap = (n: number, time: number, pitAffected = false): LapRecord => ({
  lap: n,
  time,
  pitAffected,
})

describe('formatLapTime', () => {
  it('formats a typical lap time as M:SS.mmm', () => {
    expect(formatLapTime(92.456)).toBe('1:32.456')
  })

  it('zero-pads seconds < 10', () => {
    expect(formatLapTime(61.5)).toBe('1:01.500')
  })

  it('renders sub-minute laps with M=0', () => {
    expect(formatLapTime(45.123)).toBe('0:45.123')
  })

  it('shows --:--.--- for non-positive inputs', () => {
    expect(formatLapTime(0)).toBe('--:--.---')
    expect(formatLapTime(-1)).toBe('--:--.---')
  })

  it('handles long lap times (> 1 hour treated as just-minutes)', () => {
    expect(formatLapTime(3725.001)).toBe('62:05.001')
  })
})

describe('computeStintMetrics', () => {
  it('returns all-null for empty history', () => {
    const m = computeStintMetrics([])
    expect(m.currentStint).toEqual([])
    expect(m.lastLap).toBeNull()
    expect(m.stintBest).toBeNull()
    expect(m.trendDelta).toBeNull()
    expect(m.stintBestDelta).toBeNull()
    expect(m.priorCount).toBe(0)
    expect(m.trendMature).toBe(false)
  })

  // ── Stint windowing ─────────────────────────────────────────────────────────
  it('treats the entire history as the stint when no pit-affected laps exist', () => {
    const history = [lap(1, 90), lap(2, 91), lap(3, 92)]
    const m = computeStintMetrics(history)
    expect(m.currentStint).toHaveLength(3)
    expect(m.lastLap?.lap).toBe(3)
  })

  it('starts the stint after the most recent pit-affected lap', () => {
    const history = [
      lap(1, 95, true),  // out-lap
      lap(2, 90),
      lap(3, 91),
      lap(4, 92, true),  // in-lap — stint boundary
      lap(5, 95, true),  // out-lap on new tires
      lap(6, 90),
      lap(7, 89),
    ]
    const m = computeStintMetrics(history)
    expect(m.currentStint.map((l) => l.lap)).toEqual([6, 7])
    expect(m.lastLap?.lap).toBe(7)
    expect(m.stintBest?.lap).toBe(7)
  })

  it('returns an empty stint when the most recent lap is pit-affected', () => {
    const history = [lap(1, 90), lap(2, 91), lap(3, 95, true)]
    const m = computeStintMetrics(history)
    expect(m.currentStint).toEqual([])
    expect(m.lastLap).toBeNull()
  })

  // ── Stint best ──────────────────────────────────────────────────────────────
  it('picks the fastest lap of the current stint', () => {
    const m = computeStintMetrics([lap(1, 92), lap(2, 90.5), lap(3, 91)])
    expect(m.stintBest?.lap).toBe(2)
    expect(m.stintBest?.time).toBe(90.5)
  })

  it('stint best equals last lap on a one-lap stint', () => {
    const m = computeStintMetrics([lap(1, 95, true), lap(2, 92)])
    expect(m.stintBest?.lap).toBe(2)
    expect(m.lastLap?.lap).toBe(2)
    expect(m.stintBestDelta).toBe(0)
  })

  // ── Trend window ────────────────────────────────────────────────────────────
  it('returns null trend on a 1-lap stint (no prior laps)', () => {
    const m = computeStintMetrics([lap(1, 92)])
    expect(m.trendDelta).toBeNull()
    expect(m.priorCount).toBe(0)
    expect(m.trendMature).toBe(false)
  })

  it('uses a 1-sample baseline on a 2-lap stint (not yet mature)', () => {
    const m = computeStintMetrics([lap(1, 90), lap(2, 91)])
    expect(m.trendDelta).toBeCloseTo(1, 6)
    expect(m.priorCount).toBe(1)
    expect(m.trendMature).toBe(false)
  })

  it('uses a 2-sample baseline on a 3-lap stint (still not mature)', () => {
    const m = computeStintMetrics([lap(1, 90), lap(2, 91), lap(3, 92)])
    // avg(90, 91) = 90.5; 92 - 90.5 = 1.5
    expect(m.trendDelta).toBeCloseTo(1.5, 6)
    expect(m.priorCount).toBe(2)
    expect(m.trendMature).toBe(false)
  })

  it('uses a 3-sample baseline on a 4+ lap stint (mature)', () => {
    const m = computeStintMetrics([lap(1, 90), lap(2, 90), lap(3, 90), lap(4, 91)])
    expect(m.trendDelta).toBeCloseTo(1, 6)
    expect(m.priorCount).toBe(3)
    expect(m.trendMature).toBe(true)
  })

  it('caps the trend window at 3 prior laps even on long stints', () => {
    // Laps 1-10, last lap = 95.  Prior 3 = laps 7, 8, 9 (all 90).
    const history = Array.from({ length: 9 }, (_, i) => lap(i + 1, 90))
    history.push(lap(10, 95))
    const m = computeStintMetrics(history)
    expect(m.priorCount).toBe(3)
    expect(m.trendDelta).toBeCloseTo(5, 6)
  })

  // ── Stint-best delta ────────────────────────────────────────────────────────
  it('stint-best delta is always ≥ 0 and equals (lastLap - stintBest)', () => {
    const m = computeStintMetrics([lap(1, 88), lap(2, 91), lap(3, 90)])
    expect(m.stintBestDelta).toBeCloseTo(2, 6)
    expect(m.stintBestDelta!).toBeGreaterThanOrEqual(0)
  })

  it('stint-best delta is 0 when the latest lap is the stint best', () => {
    const m = computeStintMetrics([lap(1, 92), lap(2, 91), lap(3, 90)])
    expect(m.stintBestDelta).toBe(0)
  })
})

describe('computeFuelStats', () => {
  const base = {
    fuelLevel: 30,
    fuelUsePerHour: 0,
    currentLap: 10,
    lapLastLapTime: 90,
  }

  it('uses rolling samples when available (most accurate)', () => {
    const stats = computeFuelStats({ ...base, samples: [2.0, 2.2, 1.8] })
    expect(stats.fuelPerLap).toBeCloseTo(2.0, 6)
    expect(stats.hasReliableEstimate).toBe(true)
    expect(stats.lapsOnFuel).toBeCloseTo(15, 6)
    expect(stats.pitLap).toBe(24) // floor(10 + 15 - 0.5)
  })

  it('falls back to fuelUsePerHour × lapTime when no samples', () => {
    // 7.2 L/hr × (90/3600) = 0.18 L/lap; 30 / 0.18 = 166.66 laps
    const stats = computeFuelStats({ ...base, samples: [], fuelUsePerHour: 7.2 })
    expect(stats.hasReliableEstimate).toBe(true)
    expect(stats.fuelPerLap).toBeCloseTo(0.18, 6)
  })

  it('uses LAP_TIME_ESTIMATE when lapLastLapTime is 0 and rate is high enough', () => {
    const stats = computeFuelStats({
      ...base,
      samples: [],
      fuelUsePerHour: 36, // 36 L/hr × (92/3600) = 0.92 L/lap
      lapLastLapTime: 0,
    })
    expect(stats.fuelPerLap).toBeCloseTo((36 * LAP_TIME_ESTIMATE) / 3600, 6)
    expect(stats.hasReliableEstimate).toBe(true)
  })

  it('returns no estimate when idle (fuelUsePerHour at or below threshold)', () => {
    const stats = computeFuelStats({
      ...base,
      samples: [],
      fuelUsePerHour: MIN_DRIVING_FUEL_RATE, // boundary — not strictly above
    })
    expect(stats.hasReliableEstimate).toBe(false)
    expect(stats.fuelPerLap).toBe(0)
    expect(stats.lapsOnFuel).toBe(0)
    expect(stats.pitLap).toBeNull()
  })

  it('returns 0 / null when fuel level is zero even with samples', () => {
    const stats = computeFuelStats({ ...base, fuelLevel: 0, samples: [2.0] })
    expect(stats.lapsOnFuel).toBe(0)
    expect(stats.pitLap).toBeNull()
  })

  it('rounds pitLap down to the last full lap before running dry', () => {
    // 2 L/lap, 20 L → 10 laps remaining from lap 5 → pit by lap 14 (floor(5 + 10 - 0.5))
    const stats = computeFuelStats({
      samples: [2.0],
      fuelLevel: 20,
      fuelUsePerHour: 0,
      currentLap: 5,
      lapLastLapTime: 90,
    })
    expect(stats.pitLap).toBe(14)
  })

  // ── Race-endpoint awareness (#12) ─────────────────────────────────────────
  // When sessionLapsRemain is a valid lap count, computeFuelStats decides
  // whether the race ends before fuel runs out, nullifies pitLap if so, and
  // emits the appropriate urgency tier.

  it('omits sessionLapsRemain → backward-compatible (no race-endpoint info, urgency tracks pitLap)', () => {
    const stats = computeFuelStats({ ...base, samples: [2.0] })
    expect(stats.lapsLeftInRace).toBeNull()
    expect(stats.finishOnFuel).toBe(false)
    expect(stats.pitLap).toBe(24)
    expect(stats.lapsUntilPit).toBe(14)
    // 14 laps to go is safely above the WARN threshold → 'safe'
    expect(stats.urgency).toBe('safe')
  })

  it('finishOnFuel: race ends before fuel runs out → pitLap/lapsUntilPit null, urgency "finish"', () => {
    // 20 L of fuel ÷ 2 L/lap = 10 laps of fuel; race has 5 laps left.
    const stats = computeFuelStats({
      samples: [2.0],
      fuelLevel: 20,
      fuelUsePerHour: 0,
      currentLap: 25,
      lapLastLapTime: 90,
      sessionLapsRemain: 5,
    })
    expect(stats.lapsLeftInRace).toBe(5)
    expect(stats.finishOnFuel).toBe(true)
    expect(stats.pitLap).toBeNull()
    expect(stats.lapsUntilPit).toBeNull()
    expect(stats.urgency).toBe('finish')
  })

  it('finishOnFuel boundary: exactly enough fuel for remaining race laps → finish (≤ not <)', () => {
    // 10 L ÷ 2 L/lap = 5 laps of fuel; race has 5 laps left.
    const stats = computeFuelStats({
      samples: [2.0],
      fuelLevel: 10,
      fuelUsePerHour: 0,
      currentLap: 25,
      lapLastLapTime: 90,
      sessionLapsRemain: 5,
    })
    expect(stats.finishOnFuel).toBe(true)
    expect(stats.urgency).toBe('finish')
  })

  it('fuel-forced pit when race outlasts fuel', () => {
    // 4 L ÷ 2 L/lap = 2 laps of fuel; race has 8 laps left → forced pit.
    const stats = computeFuelStats({
      samples: [2.0],
      fuelLevel: 4,
      fuelUsePerHour: 0,
      currentLap: 22,
      lapLastLapTime: 90,
      sessionLapsRemain: 8,
    })
    expect(stats.finishOnFuel).toBe(false)
    expect(stats.lapsLeftInRace).toBe(8)
    expect(stats.pitLap).toBe(23) // floor(22 + 2 - 0.5)
    expect(stats.lapsUntilPit).toBe(1)
    expect(stats.urgency).toBe('danger')
  })

  it('rejects sentinel sessionLapsRemain (-1 for timed races) — falls back to no-info', () => {
    const stats = computeFuelStats({ ...base, samples: [2.0], sessionLapsRemain: -1 })
    expect(stats.lapsLeftInRace).toBeNull()
    expect(stats.finishOnFuel).toBe(false)
    // Same result as if sessionLapsRemain were omitted entirely.
    expect(stats.pitLap).toBe(24)
  })

  it('rejects implausibly-large sessionLapsRemain (32767 sentinel) — falls back to no-info', () => {
    const stats = computeFuelStats({
      ...base,
      samples: [2.0],
      sessionLapsRemain: MAX_USABLE_LAPS_REMAIN + 1,
    })
    expect(stats.lapsLeftInRace).toBeNull()
    expect(stats.finishOnFuel).toBe(false)
  })

  it('rejects fractional sessionLapsRemain >= 1 by flooring (defensive)', () => {
    // SDK returns ints, but defensive guard: 5.7 should be treated as 5 laps.
    const stats = computeFuelStats({
      samples: [2.0],
      fuelLevel: 20,
      fuelUsePerHour: 0,
      currentLap: 25,
      lapLastLapTime: 90,
      sessionLapsRemain: 5.7,
    })
    expect(stats.lapsLeftInRace).toBe(5)
    expect(stats.finishOnFuel).toBe(true)
  })

  describe('sessionLapsRemain === 0 (race over for this car) — #70', () => {
    // At the start of the final lap of a timed race, iRacing transitions
    // sessionLapsRemain from a small positive integer to 0 for this car.
    // The pre-#70 `>= 1` cutoff classified that as "no info" and flipped
    // the headline from green "Finish on fuel" back to "Pit in N laps"
    // even though the race was already done for the player.

    it('treats 0 as race-over → finishOnFuel = true, urgency = finish', () => {
      const stats = computeFuelStats({
        samples: [2.0],
        fuelLevel: 35,
        fuelUsePerHour: 0,
        currentLap: 5,
        lapLastLapTime: 90,
        sessionLapsRemain: 0,
      })
      expect(stats.lapsLeftInRace).toBe(0)
      expect(stats.finishOnFuel).toBe(true)
      expect(stats.urgency).toBe('finish')
      expect(stats.pitLap).toBeNull()
      expect(stats.lapsUntilPit).toBeNull()
    })

    it('treats 0 as race-over even without a fuel estimate', () => {
      // No samples, no live rate — fuel info is unknown. We still want
      // finishOnFuel=true because the race is over regardless of fuel.
      const stats = computeFuelStats({
        samples: [],
        fuelLevel: 5,
        fuelUsePerHour: 0,
        currentLap: 5,
        lapLastLapTime: 0,
        sessionLapsRemain: 0,
      })
      expect(stats.lapsLeftInRace).toBe(0)
      expect(stats.finishOnFuel).toBe(true)
      expect(stats.urgency).toBe('finish')
    })

    it('sessionLapsRemain === 1 (white-flag lap in progress) → finishOnFuel if fuel covers', () => {
      // Boundary above 0: 1 lap remains, fuel covers many more laps.
      const stats = computeFuelStats({
        samples: [2.0],
        fuelLevel: 35,
        fuelUsePerHour: 0,
        currentLap: 4,
        lapLastLapTime: 90,
        sessionLapsRemain: 1,
      })
      expect(stats.lapsLeftInRace).toBe(1)
      expect(stats.finishOnFuel).toBe(true)
    })

    it('still rejects -1 (timed-race sentinel) — distinct from 0', () => {
      // Defence against regressing the sentinel handling while adding the
      // 0 case. -1 must still be treated as "no info".
      const stats = computeFuelStats({ ...base, samples: [2.0], sessionLapsRemain: -1 })
      expect(stats.lapsLeftInRace).toBeNull()
      expect(stats.finishOnFuel).toBe(false)
    })
  })

  describe('sessionState >= 5 (Checkered / CoolDown) — #70 follow-up', () => {
    // After the checkered, iRacing can revert `sessionLapsRemain` to a
    // stale positive integer or sentinel as the field transitions into
    // cool-down. SessionState is the durable signal: 5 = Checkered,
    // 6 = CoolDown — both mean the race is over for the field, and the
    // Pit Strategy headline should stay green "Finish on fuel" regardless
    // of what SessionLapsRemain does next.

    it('sessionState = 5 (Checkered) latches finishOnFuel even with stale sessionLapsRemain', () => {
      // Reproduces the user-reported scenario: 9-lap race finishes,
      // SessionLapsRemain resurfaces as 9, fuel-only calc would say
      // "Pit in 9 laps". SessionState >= 5 short-circuits that.
      const stats = computeFuelStats({
        samples: [2.0],
        fuelLevel: 19.6,      // ~9.8 laps of fuel (matches the screenshot)
        fuelUsePerHour: 0,
        currentLap: 9,
        lapLastLapTime: 90,
        sessionLapsRemain: 9, // stale, post-race; would otherwise drive "Pit in 9 laps"
        sessionState: 5,
      })
      expect(stats.finishOnFuel).toBe(true)
      expect(stats.urgency).toBe('finish')
      expect(stats.pitLap).toBeNull()
      expect(stats.lapsUntilPit).toBeNull()
    })

    it('sessionState = 6 (CoolDown) also latches finishOnFuel', () => {
      const stats = computeFuelStats({
        samples: [2.0],
        fuelLevel: 30,
        fuelUsePerHour: 0,
        currentLap: 9,
        lapLastLapTime: 90,
        sessionLapsRemain: -1, // sentinel — would otherwise be "no info"
        sessionState: 6,
      })
      expect(stats.finishOnFuel).toBe(true)
      expect(stats.urgency).toBe('finish')
    })

    it('sessionState = 4 (Racing) does NOT force finish — falls back to fuel/laps math', () => {
      // Mid-race state must behave like #12: pit-forced calc when fuel
      // can't cover the remaining laps.
      const stats = computeFuelStats({
        samples: [2.0],
        fuelLevel: 4,
        fuelUsePerHour: 0,
        currentLap: 22,
        lapLastLapTime: 90,
        sessionLapsRemain: 8,
        sessionState: 4,
      })
      expect(stats.finishOnFuel).toBe(false)
      expect(stats.pitLap).toBe(23)
      expect(stats.urgency).toBe('danger')
    })

    it('omitting sessionState is backward-compatible (#12-era callers)', () => {
      // Tests + callers that haven't been updated yet should get the
      // same behaviour as before this PR — race-over decided purely by
      // sessionLapsRemain.
      const stats = computeFuelStats({
        samples: [2.0],
        fuelLevel: 4,
        fuelUsePerHour: 0,
        currentLap: 22,
        lapLastLapTime: 90,
        sessionLapsRemain: 8,
      })
      expect(stats.finishOnFuel).toBe(false)
      expect(stats.urgency).toBe('danger')
    })

    it('sessionState in pre-race phases (Warmup, ParadeLaps) does NOT force finish', () => {
      // States 0-3 must behave neutrally — the pre-race grid isn't a
      // race-over signal even though it's not state 4.
      for (const preRaceState of [0, 1, 2, 3]) {
        const stats = computeFuelStats({
          samples: [2.0],
          fuelLevel: 4,
          fuelUsePerHour: 0,
          currentLap: 1,
          lapLastLapTime: 0,
          sessionLapsRemain: 10,
          sessionState: preRaceState,
        })
        expect(stats.finishOnFuel, `state=${preRaceState}`).toBe(false)
      }
    })
  })
})

describe('urgencyFor', () => {
  it('finishOnFuel always wins regardless of lapsUntilPit', () => {
    expect(urgencyFor(0, true)).toBe('finish')
    expect(urgencyFor(50, true)).toBe('finish')
    expect(urgencyFor(null, true)).toBe('finish')
  })

  it('null lapsUntilPit + no finish → unknown', () => {
    expect(urgencyFor(null, false)).toBe('unknown')
  })

  it('classifies by laps-until-pit threshold', () => {
    // Below danger threshold (3) → danger
    expect(urgencyFor(0, false)).toBe('danger')
    expect(urgencyFor(1, false)).toBe('danger')
    expect(urgencyFor(URGENCY_DANGER_THRESHOLD - 1, false)).toBe('danger')
    // Between danger and warn → warn
    expect(urgencyFor(URGENCY_DANGER_THRESHOLD, false)).toBe('warn')
    expect(urgencyFor(URGENCY_WARN_THRESHOLD - 1, false)).toBe('warn')
    // At or above warn → safe
    expect(urgencyFor(URGENCY_WARN_THRESHOLD, false)).toBe('safe')
    expect(urgencyFor(URGENCY_WARN_THRESHOLD + 10, false)).toBe('safe')
  })
})

describe('pitCountdownLabel', () => {
  it('returns null when lapsUntilPit is unknown', () => {
    expect(pitCountdownLabel(null)).toBeNull()
  })

  it('reads "Pit this lap" at 0 laps remaining', () => {
    expect(pitCountdownLabel(0)).toBe('Pit this lap')
  })

  it('reads "Pit next lap" at 1 lap remaining', () => {
    // The boundary "Pit in 1 lap" wording is ambiguous mid-race (is it the
    // lap you\'re on or the one after?) — special-casing 1 to "next lap"
    // makes the intent unambiguous.  See #12 discussion.
    expect(pitCountdownLabel(1)).toBe('Pit next lap')
  })

  it('reads "Pit in N laps" for everything else', () => {
    expect(pitCountdownLabel(2)).toBe('Pit in 2 laps')
    expect(pitCountdownLabel(5)).toBe('Pit in 5 laps')
    expect(pitCountdownLabel(13)).toBe('Pit in 13 laps')
  })
})

// ── reducePitTracker ─────────────────────────────────────────────────────────
// State machine that drives the Pit Strategy overlay's lap-history and fuel
// sampling.  Replaces the previous shape (two useEffects with refs in
// index.tsx) and adds reliable session-transition handling — see #39.

/** Helper: minimal tick with sensible defaults; override only what each test cares about. */
const tick = (overrides: Partial<PitTrackerTick> = {}): PitTrackerTick => ({
  connected: true,
  sessionType: 'race',
  lap: 1,
  lapLastLapTime: 0,
  fuelLevel: 50,
  playerInPit: false,
  ...overrides,
})

/** Helper: feed a sequence of ticks into the reducer and return the final state. */
const run = (ticks: PitTrackerTick[], initial: PitTrackerState = INITIAL_PIT_TRACKER_STATE) =>
  ticks.reduce((s, t) => reducePitTracker(s, t), initial)

describe('reducePitTracker — session transitions', () => {
  it('reproduces #39: practice/qualifying laps don\'t poison a subsequent race stint', () => {
    // 1. Player ran 8 laps in qualifying (some slow out-laps around 1:32).
    // 2. Race session starts; lap counter drops back toward 1.
    // 3. Race laps come in.  The race stint should be the race laps only.
    let state = INITIAL_PIT_TRACKER_STATE
    // Push 8 qualifying laps.
    for (let lap = 2; lap <= 9; lap++) {
      state = reducePitTracker(state, tick({
        sessionType: 'qualifying',
        lap,
        lapLastLapTime: 92 + (lap - 2) * 0.1,
        fuelLevel: 60 - (lap - 2) * 0.5,
      }))
    }
    expect(state.lapHistory).toHaveLength(8)

    // Session transition: now in race, lap counter dropped to 1 (no completed
    // lap yet).  Critically, lapLastLapTime is briefly 0 — this is the exact
    // window where the old code's early-return ate the reset.
    state = reducePitTracker(state, tick({ sessionType: 'race', lap: 1, lapLastLapTime: 0, fuelLevel: 80 }))
    expect(state.lapHistory).toEqual([])
    expect(state.lastTrackedLap).toBe(0)

    // Now a race lap completes — push lap 1 at 67.5s, then lap 2.
    state = reducePitTracker(state, tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67.5, fuelLevel: 78 }))
    state = reducePitTracker(state, tick({ sessionType: 'race', lap: 3, lapLastLapTime: 67.4, fuelLevel: 76 }))
    expect(state.lapHistory.map((l) => l.lap)).toEqual([1, 2])
    expect(state.lapHistory[0].time).toBeCloseTo(67.5, 6)
  })

  it('clears state when sessionType moves between two known values', () => {
    const before = run([
      tick({ sessionType: 'practice', lap: 2, lapLastLapTime: 92, fuelLevel: 50 }),
      tick({ sessionType: 'practice', lap: 3, lapLastLapTime: 91, fuelLevel: 48 }),
    ])
    expect(before.lapHistory).toHaveLength(2)
    const after = reducePitTracker(before, tick({ sessionType: 'race', lap: 1, fuelLevel: 80 }))
    expect(after.lapHistory).toEqual([])
    expect(after.lastTrackedLap).toBe(0)
    expect(after.prevSessionType).toBe('race')
  })

  it('does NOT treat the initial unknown → known transition as a session change', () => {
    // First tick of the session: prevSessionType is 'unknown' (the default).
    // Moving to 'practice' shouldn't trigger a reset — there's nothing to reset.
    const state = reducePitTracker(INITIAL_PIT_TRACKER_STATE, tick({ sessionType: 'practice', lap: 1, fuelLevel: 50 }))
    expect(state.prevSessionType).toBe('practice')
    expect(state.fuelAtLapStart).toBe(50) // bootstrap fired
  })

  it('does NOT clear when sessionType flickers to unknown (e.g. transient disconnect)', () => {
    const before = run([
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67, fuelLevel: 50 }),
      tick({ sessionType: 'race', lap: 3, lapLastLapTime: 67.1, fuelLevel: 48 }),
    ])
    const after = reducePitTracker(before, tick({ sessionType: 'unknown', lap: 3, fuelLevel: 48 }))
    expect(after.lapHistory).toHaveLength(2)
  })

  it('clears on a backward lap counter even when sessionType is unchanged (replay rewind)', () => {
    const before = run([
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67, fuelLevel: 50 }),
      tick({ sessionType: 'race', lap: 3, lapLastLapTime: 67, fuelLevel: 48 }),
      tick({ sessionType: 'race', lap: 4, lapLastLapTime: 67, fuelLevel: 46 }),
    ])
    expect(before.lapHistory).toHaveLength(3)
    // Replay rewind: same session type, lap counter goes back.
    const after = reducePitTracker(before, tick({ sessionType: 'race', lap: 2, fuelLevel: 50 }))
    expect(after.lapHistory).toEqual([])
  })

  it('no-ops on a disconnected tick', () => {
    const before = run([tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67, fuelLevel: 50 })])
    const after = reducePitTracker(before, tick({ connected: false, sessionType: 'race', lap: 99 }))
    expect(after).toBe(before)
  })
})

describe('reducePitTracker — lap boundaries', () => {
  it('pushes a LapRecord with the just-completed lap number, time, and pit-flag', () => {
    const state = run([
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80 }),
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67.5, fuelLevel: 78 }),
    ])
    expect(state.lapHistory).toEqual([
      { lap: 1, time: 67.5, pitAffected: true }, // initial flag: starts in pit
    ])
    expect(state.lastTrackedLap).toBe(2)
    expect(state.wasInPitThisLap).toBe(false) // reset on lap boundary
  })

  it('does not push when lap counter advances but lapLastLapTime is briefly 0', () => {
    let state = run([
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80 }),
      // Counter advances but lap time hasn't propagated yet — common race condition.
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 0, fuelLevel: 78 }),
    ])
    expect(state.lapHistory).toEqual([])
    expect(state.lastTrackedLap).toBe(0) // unchanged — waiting for the lap time

    // Next tick has the lap time — now we push.
    state = reducePitTracker(state, tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67.5, fuelLevel: 78 }))
    expect(state.lapHistory.map((l) => l.lap)).toEqual([1])
    expect(state.lastTrackedLap).toBe(2)
  })

  it('caps the lap history at LAP_HISTORY_WINDOW entries', () => {
    let state = INITIAL_PIT_TRACKER_STATE
    for (let lap = 2; lap <= LAP_HISTORY_WINDOW + 5; lap++) {
      state = reducePitTracker(state, tick({ sessionType: 'race', lap, lapLastLapTime: 67, fuelLevel: 80 }))
    }
    // Ticks at lap=2..LAP_HISTORY_WINDOW+5 push records for laps 1..LAP_HISTORY_WINDOW+4.
    // After capping, the oldest (LAP_HISTORY_WINDOW+4 − LAP_HISTORY_WINDOW = 4) are dropped.
    expect(state.lapHistory).toHaveLength(LAP_HISTORY_WINDOW)
    expect(state.lapHistory[0].lap).toBe(5)
    expect(state.lapHistory[state.lapHistory.length - 1].lap).toBe(LAP_HISTORY_WINDOW + 4)
  })
})

describe('reducePitTracker — pit-affected flag', () => {
  it('sticks across ticks within a single lap', () => {
    const state = run([
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80, playerInPit: false }),
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80, playerInPit: true }),  // brief pit visit
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80, playerInPit: false }), // back on track
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67, fuelLevel: 78, playerInPit: false }),
    ])
    expect(state.lapHistory[0].pitAffected).toBe(true)
  })

  it('clears at the lap boundary and a fresh non-pit lap is clean', () => {
    let state = run([
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80, playerInPit: true }),
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 95, fuelLevel: 78, playerInPit: false }), // out-lap
    ])
    expect(state.lapHistory[0].pitAffected).toBe(true)

    // Next lap: no pit visit at all.
    state = reducePitTracker(state, tick({ sessionType: 'race', lap: 3, lapLastLapTime: 67, fuelLevel: 76 }))
    expect(state.lapHistory[1].pitAffected).toBe(false)
  })
})

describe('reducePitTracker — fuel sampling', () => {
  it('pushes a per-lap sample alongside the lap record', () => {
    const state = run([
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80 }),                              // bootstrap fuelAtLapStart=80
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67, fuelLevel: 78 }),          // consumed=2
      tick({ sessionType: 'race', lap: 3, lapLastLapTime: 67, fuelLevel: 76.1 }),        // consumed=1.9
    ])
    expect(state.fuelPerLapSamples).toHaveLength(2)
    expect(state.fuelPerLapSamples[0]).toBeCloseTo(2, 6)
    expect(state.fuelPerLapSamples[1]).toBeCloseTo(1.9, 6)
  })

  it('rejects implausible samples (refuel — negative consumed)', () => {
    const state = run([
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80 }),
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67, fuelLevel: 100 }), // refuelled — consumed = -20
    ])
    expect(state.fuelPerLapSamples).toEqual([])
  })

  it('rejects implausible samples (>15 L on a single lap)', () => {
    const state = run([
      tick({ sessionType: 'race', lap: 1, fuelLevel: 80 }),
      tick({ sessionType: 'race', lap: 2, lapLastLapTime: 67, fuelLevel: 60 }), // consumed = 20
    ])
    expect(state.fuelPerLapSamples).toEqual([])
  })

  it('caps the rolling sample buffer at FUEL_SAMPLE_WINDOW', () => {
    let state: PitTrackerState = INITIAL_PIT_TRACKER_STATE
    let fuel = 80
    state = reducePitTracker(state, tick({ sessionType: 'race', lap: 1, fuelLevel: fuel }))
    for (let lap = 2; lap <= FUEL_SAMPLE_WINDOW + 3; lap++) {
      fuel -= 2
      state = reducePitTracker(state, tick({ sessionType: 'race', lap, lapLastLapTime: 67, fuelLevel: fuel }))
    }
    expect(state.fuelPerLapSamples).toHaveLength(FUEL_SAMPLE_WINDOW)
  })

  it('clears samples on session transition', () => {
    const before = run([
      tick({ sessionType: 'practice', lap: 1, fuelLevel: 80 }),
      tick({ sessionType: 'practice', lap: 2, lapLastLapTime: 67, fuelLevel: 78 }),
      tick({ sessionType: 'practice', lap: 3, lapLastLapTime: 67, fuelLevel: 76 }),
    ])
    expect(before.fuelPerLapSamples).toHaveLength(2)
    const after = reducePitTracker(before, tick({ sessionType: 'race', lap: 1, fuelLevel: 90 }))
    expect(after.fuelPerLapSamples).toEqual([])
    expect(after.fuelAtLapStart).toBe(-1) // re-bootstrap on next tick
  })
})
