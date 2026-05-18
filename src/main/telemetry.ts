import { getPreviewMode } from './previewMode.js'

export type SessionType = 'practice' | 'qualifying' | 'race' | 'unknown'
export type TireCorner = readonly [number, number, number]

export interface CarCapabilities {
  hasTractionControl: boolean
  hasABS: boolean
}

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
  lastLapTime: number
  bestLapTime: number
  f2Time: number       // seconds relative to player; negative = ahead
  startPosition: number
}

export interface IRacingTelemetry {
  connected: boolean
  /** True only while the driver is in their cockpit and the session is live.
   *  False in the garage, get-in-car screen, replays, spectator mode, or after
   *  the car has been removed from the world. Overlays use this to hide when
   *  the user is in iRacing menus rather than actually driving. */
  isOnTrack: boolean
  sessionType: SessionType
  sessionTime: number
  sessionTimeRemain: number
  /** iRacing's `SessionLapsRemain`: laps left in the current session.
   *
   *  Reliable positive integer in lap-counted races (e.g. `28` with 2 laps
   *  to go in a 30-lap race).  Timed races return a sentinel (typically
   *  `-1` or `32767`) until the leader crosses the line at the end of
   *  time, at which point it counts down the remaining laps after the
   *  checkered flag.
   *
   *  Consumers should treat values outside `[1, 9999]` as "not a usable
   *  lap-count" and fall back to `sessionTimeRemain` or no race-endpoint
   *  awareness at all.  See `PitStrategy/lib.ts` → `computeFuelStats()`
   *  for the canonical guard. */
  sessionLapsRemain: number

  playerCarIdx: number
  playerCarRedLine: number  // RPM at rev limiter (from session YAML DriverCarRedLine)
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
  lapDeltaToBestLap: number
  lapDistPct: number

  tireLF: TireCorner
  tireRF: TireCorner
  tireLR: TireCorner
  tireRR: TireCorner
  carLeftRight: number

  /** Traction control — level is the dial setting (0 = off), active = currently intervening */
  tc:  { level: number; active: boolean }
  /** Anti-lock brakes — level is the dial setting (0 = off), active = currently intervening */
  abs: { level: number; active: boolean }

  cars: CarTelemetry[]
  drivers: DriverInfo[]
  capabilities: CarCapabilities
}

export type TelemetryCallback = (telemetry: IRacingTelemetry) => void

let pollingInterval: ReturnType<typeof setInterval> | null = null

export async function startTelemetryPolling(callback: TelemetryCallback): Promise<void> {
  // Always load mock — needed when preview mode is on even if SDK is available
  const { createMockPoller } = await import('./mockTelemetry.js')
  const mocker = createMockPoller()

  // Try real SDK
  const { tryInit, poll, cleanup } = await import('./iracingSdk.js')
  const sdkReady = await tryInit()
  if (sdkReady) {
    process.on('exit', cleanup)
  }

  pollingInterval = setInterval(() => {
    const preview = getPreviewMode()
    if (preview.enabled || !sdkReady) {
      mocker.setSessionType(preview.sessionType)
      callback(mocker.next())
    } else {
      callback(poll())
    }
  }, 100)
}

export function stopTelemetryPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval)
    pollingInterval = null
  }
}
