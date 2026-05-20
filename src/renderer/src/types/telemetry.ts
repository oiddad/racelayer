export type SessionType = 'practice' | 'qualifying' | 'race' | 'unknown'

/** Feature flags for the current car — detected once per connection from the SDK var map. */
export interface CarCapabilities {
  /** Car exposes dcTractionControl (adjustable TC dial). */
  hasTractionControl: boolean
  /** Car exposes dcABS (adjustable ABS dial). */
  hasABS: boolean
}

/** Tire corner temperatures in °C: [inner, middle, outer] */
export type TireCorner = readonly [number, number, number]

export interface DriverInfo {
  carIdx: number
  userName: string
  iRating: number
  safetyRating: string // e.g. "A 4.32"
  carNumber: string
  carName: string
  isAI: boolean
}

export interface CarTelemetry {
  carIdx: number
  position: number
  lapDistPct: number
  lap: number
  onTrack: boolean
  inPit: boolean
  lastLapTime: number  // seconds, 0 if no lap completed
  bestLapTime: number
  /** `CarIdxF2Time` — seconds behind the session leader (NOT the player), and
   *  0 for cars that haven't set a lap time yet.  For player-relative gaps use
   *  `computeRelativeGap()` in `overlays/Relative/lib.ts` instead. */
  f2Time: number
  startPosition: number
}

export interface IRacingTelemetry {
  connected: boolean
  /** True only while the driver is in their cockpit and the session is live.
   *  False in the garage, get-in-car screen, replays, or spectator mode.
   *  Overlays use this to hide themselves when the user is in iRacing menus. */
  isOnTrack: boolean
  sessionType: SessionType
  sessionTime: number
  sessionTimeRemain: number
  /** Laps left in the current session.  Positive integer for lap-counted
   *  races; a sentinel (`-1` or `32767`) for timed races.  See
   *  `src/main/telemetry.ts` for the canonical guard semantics. */
  sessionLapsRemain: number
  /** iRacing's `SessionState` enum — overall session phase, not this car's
   *  progress.  `0` Invalid | `1` GetInCar | `2` Warmup | `3` ParadeLaps |
   *  `4` Racing | `5` Checkered | `6` CoolDown.  `>= 5` means the race is
   *  over for the whole field — Pit Strategy latches the green
   *  "Finish on fuel" affordance on this signal so the headline can't flip
   *  back to "Pit in N laps" if `sessionLapsRemain` reverts post-checkered.
   *  See #70 follow-up. */
  sessionState: number

  playerCarIdx: number
  playerCarRedLine: number  // RPM at rev limiter
  /** iRacing's `ShiftIndicatorPct`: 0-1 ramp that hits 1.0 at the per-car
   *  optimum shift point.  When this field is unavailable (older SDK builds,
   *  car not configured, var map miss), it's `NaN` — overlays fall back to a
   *  percentage-of-redline heuristic.  See `Gauges/lib.ts` → `rpmZone()`. */
  shiftIndicatorPct: number
  speed: number         // m/s
  gear: number          // -1=R, 0=N, 1–8
  rpm: number
  throttle: number      // 0–1
  brake: number         // 0–1
  fuelLevel: number     // liters
  fuelUsePerHour: number
  lap: number
  lapCurrentLapTime: number
  lapLastLapTime: number
  lapBestLapTime: number
  lapDeltaToBestLap: number // negative = currently ahead of best pace
  lapDistPct: number

  // Tire temperatures °C — [inner, middle, outer] for each corner
  tireLF: TireCorner
  tireRF: TireCorner
  tireLR: TireCorner
  tireRR: TireCorner

  /** irsdk_CarLeftRight:
   *   0 LROff | 1 LRClear | 2 CarLeft | 3 CarRight |
   *   4 CarLeftRight | 5 2CarsLeft | 6 2CarsRight
   * See `overlays/Relative/lib.ts` for named constants. */
  carLeftRight: number

  /** Traction control — level is the dial setting (0 = off), active = currently intervening */
  tc:  { level: number; active: boolean }
  /** Anti-lock brakes — level is the dial setting (0 = off), active = currently intervening */
  abs: { level: number; active: boolean }

  cars: CarTelemetry[]
  drivers: DriverInfo[]
  capabilities: CarCapabilities
}

export const EMPTY_TELEMETRY: IRacingTelemetry = {
  connected: false,
  isOnTrack: false,
  sessionType: 'unknown',
  sessionTime: 0,
  sessionTimeRemain: 0,
  sessionLapsRemain: -1,
  sessionState: 0,
  playerCarIdx: 0,
  playerCarRedLine: 0,
  shiftIndicatorPct: NaN,
  speed: 0,
  gear: 0,
  rpm: 0,
  throttle: 0,
  brake: 0,
  fuelLevel: 0,
  fuelUsePerHour: 0,
  lap: 0,
  lapCurrentLapTime: 0,
  lapLastLapTime: 0,
  lapBestLapTime: 0,
  lapDeltaToBestLap: NaN,
  lapDistPct: 0,
  tireLF: [0, 0, 0],
  tireRF: [0, 0, 0],
  tireLR: [0, 0, 0],
  tireRR: [0, 0, 0],
  carLeftRight: 0,
  tc:  { level: 0, active: false },
  abs: { level: 0, active: false },
  cars: [],
  drivers: [],
  capabilities: { hasTractionControl: false, hasABS: false },
}
