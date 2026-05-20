/**
 * iRacing SDK reader — pure JS/FFI approach via koffi.
 *
 * iRacing exposes all telemetry through a Windows named memory-mapped file
 * ("Local\IRSDKMemMapFileName"). We open it read-only with Win32 API calls,
 * copy the whole block into a Buffer each tick, then extract values by their
 * byte offsets as described in the iRacing SDK header (irsdk_defines.h).
 *
 * No native compilation needed — koffi ships prebuilt NAPI binaries.
 */

import yaml from 'js-yaml'
import type { IRacingTelemetry, DriverInfo, CarTelemetry, SessionType, CarCapabilities } from './telemetry.js'

// ── Constants ────────────────────────────────────────────────────────────────

const MEMMAPNAME = 'Local\\IRSDKMemMapFileName'
const FILE_MAP_READ = 0x0004
const IRSDK_STCONNECTED = 1      // status bit: iRacing is live
const MAX_CARS = 64

// irsdk variable types
const VTYPE = { Char: 0, Bool: 1, Int: 2, BitField: 3, Float: 4, Double: 5 }

// Byte offsets within irsdk_header (first ~112 bytes of the mapped file)
const HDR = {
  STATUS:           4,
  SESSION_INFO_VER: 12,
  SESSION_INFO_LEN: 16,
  SESSION_INFO_OFF: 20,
  NUM_VARS:         24,
  VAR_HDR_OFFSET:   28,
  BUF_LEN:          36,
  VARBUF_START:     48,   // irsdk_varBuf[4] begins here
}

// irsdk_varBuf is 16 bytes each
const VARBUF_TICKCOUNT = 0
const VARBUF_OFFSET    = 4
const VARBUF_STRIDE    = 16

// irsdk_varHeader is 144 bytes each
const VARHDR = { TYPE: 0, OFFSET: 4, COUNT: 8, NAME: 16 }
const VARHDR_STRIDE = 144

// ── Module-level state ───────────────────────────────────────────────────────

interface VarInfo { type: number; offset: number; count: number }

// Koffi function handles (set in tryInit)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let koffi: any = null
// Koffi type for reading the shared-memory block.
// Created dynamically on first connect (size read from header) and cached.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedMemType: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fnOpenFileMapping: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fnMapViewOfFile: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fnUnmapViewOfFile: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fnCloseHandle: any = null

// Shared-memory handles
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let memHandle: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let memPtr: any = null

// Parsed state — refreshed when iRacing session changes
const varMap = new Map<string, VarInfo>()
let lastSessionInfoVer = -1
let sessionYamlTypes: Array<{ num: number; type: SessionType }> = []
let cachedDrivers: DriverInfo[] = []
let cachedPlayerCarIdx = 0
let cachedRedLine = 0  // RPM, from DriverInfo.DriverCarRedLine in session YAML
const startPositions = new Map<number, number>() // carIdx → grid position (race only)

// Feature flags for the current car — reset each time the shared memory is opened.
let carCapabilities: CarCapabilities = { hasTractionControl: false, hasABS: false }

// ── Diagnostic state for #64 (temporary) ─────────────────────────────────────
// Remembered cockpit-state struct from the previous tick — used by
// logCockpitDelta() to log only on state changes (otherwise every poll would
// emit a line, ~10/sec). Reset in closeMemory() so a fresh session re-logs.
type CockpitDebugState = {
  isOnTrack: boolean
  isInGarage: boolean | null
  isReplayPlaying: boolean | null
  isOnTrackCar: boolean | null
  playerSurface: number
}
let prevCockpitDebug: CockpitDebugState | null = null

function surfaceLabel(s: number): string {
  switch (s) {
    case -1: return '(NotInWorld)'
    case 0:  return '(OffTrack)'
    case 1:  return '(InPitStall)'
    case 2:  return '(AproachingPits)'
    case 3:  return '(OnTrack)'
    default: return '(unknown)'
  }
}

function logCockpitDelta(s: CockpitDebugState): void {
  if (
    prevCockpitDebug !== null
    && prevCockpitDebug.isOnTrack       === s.isOnTrack
    && prevCockpitDebug.isInGarage      === s.isInGarage
    && prevCockpitDebug.isReplayPlaying === s.isReplayPlaying
    && prevCockpitDebug.isOnTrackCar    === s.isOnTrackCar
    && prevCockpitDebug.playerSurface   === s.playerSurface
  ) return
  console.log(
    '[irsdk-cockpit-debug]',
    'isOnTrack=' + s.isOnTrack,
    'isInGarage=' + (s.isInGarage === null ? '(missing)' : s.isInGarage),
    'isReplayPlaying=' + (s.isReplayPlaying === null ? '(missing)' : s.isReplayPlaying),
    'isOnTrackCar=' + (s.isOnTrackCar === null ? '(missing)' : s.isOnTrackCar),
    'playerSurface=' + s.playerSurface + ' ' + surfaceLabel(s.playerSurface),
  )
  prevCockpitDebug = s
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load koffi and bind Win32 API. Returns false if koffi is not installed. */
export async function tryInit(): Promise<boolean> {
  try {
    const mod = await import('koffi')
    koffi = (mod as any).default ?? mod
    const kernel32 = koffi.load('kernel32.dll')

    fnOpenFileMapping = kernel32.func('void *OpenFileMappingA(uint32 dwDesiredAccess, int32 bInheritHandle, str lpName)')
    fnMapViewOfFile   = kernel32.func('void *MapViewOfFile(void *hFileMappingObject, uint32 dwDesiredAccess, uint32 dwFileOffsetHigh, uint32 dwFileOffsetLow, int64 dwNumberOfBytesToMap)')
    fnUnmapViewOfFile = kernel32.func('int32 UnmapViewOfFile(void *lpBaseAddress)')
    fnCloseHandle     = kernel32.func('int32 CloseHandle(void *hObject)')

    console.log('[irsdk] koffi loaded — will use real iRacing telemetry')
    return true
  } catch (e) {
    console.log('[irsdk] koffi unavailable — falling back to mock data:', (e as Error).message)
    return false
  }
}

/**
 * Read one frame of telemetry.
 * Returns a disconnected frame if iRacing isn't running.
 * Returns null only if koffi failed to load (caller should use mock instead).
 */
export function poll(): IRacingTelemetry {
  if (!ensureConnected()) return { ...DISCONNECTED }

  const buf = readFullBuffer()
  if (!buf) { closeMemory(); return { ...DISCONNECTED } }

  // Check iRacing live status bit
  if (!(buf.readInt32LE(HDR.STATUS) & IRSDK_STCONNECTED)) {
    closeMemory()
    return { ...DISCONNECTED }
  }

  if (varMap.size === 0) buildVarMap(buf)

  // Refresh session YAML when it changes (new session, driver joins, etc.)
  const sessionInfoVer = buf.readInt32LE(HDR.SESSION_INFO_VER)
  if (sessionInfoVer !== lastSessionInfoVer) {
    lastSessionInfoVer = sessionInfoVer
    parseSessionYaml(buf)
  }

  return extractTelemetry(buf)
}

export function cleanup(): void {
  closeMemory()
}

// ── Private helpers ──────────────────────────────────────────────────────────

function ensureConnected(): boolean {
  if (memPtr) return true
  try {
    memHandle = fnOpenFileMapping(FILE_MAP_READ, 0, MEMMAPNAME)
    if (!memHandle) return false
    memPtr = fnMapViewOfFile(memHandle, FILE_MAP_READ, 0, 0, 0)
    if (!memPtr) { fnCloseHandle(memHandle); memHandle = null; return false }
    return true
  } catch {
    memHandle = null; memPtr = null
    return false
  }
}

function closeMemory(): void {
  if (memPtr)    { try { fnUnmapViewOfFile(memPtr) } catch {} memPtr = null }
  if (memHandle) { try { fnCloseHandle(memHandle)  } catch {} memHandle = null }
  varMap.clear()
  lastSessionInfoVer = -1
  cachedRedLine = 0
  cachedMemType = null  // re-probe size on next connect
  carCapabilities = { hasTractionControl: false, hasABS: false }
  prevCockpitDebug = null  // diagnostic for #64 — re-log from scratch next session
}

function readFullBuffer(): Buffer | null {
  try {
    // Phase 1 (first connect): read just the 256-byte header to discover the
    // exact layout of the shared memory.  The data buffers can live at offsets
    // well beyond 780 KB on large sessions; we must not over-read or we get a
    // native access violation (the OS only maps the file's actual size).
    if (!cachedMemType) {
      const SmallType = koffi.array('uint8', 256)
      const smallBytes = koffi.decode(memPtr, SmallType) as Uint8Array
      const hdr = Buffer.from(smallBytes)

      // BUF_LEN (offset 36) = byte length of each rotating data buffer
      const bufLen = hdr.readInt32LE(HDR.BUF_LEN)

      // Each of the 4 irsdk_varBuf entries has its absolute file offset at +4
      let maxOff = 0
      for (let i = 0; i < 4; i++) {
        const base = HDR.VARBUF_START + i * VARBUF_STRIDE
        const off  = hdr.readInt32LE(base + VARBUF_OFFSET)
        if (off > 0) maxOff = Math.max(maxOff, off)
      }

      // Guard against a corrupt/zeroed header on very first connection attempt
      if (maxOff === 0 || bufLen <= 0) return null

      const needed = maxOff + bufLen + 512   // tiny tail-padding for safety
      cachedMemType = koffi.array('uint8', needed)
      console.log(`[irsdk] shared-memory layout: ${(needed / 1024).toFixed(0)} KB ` +
                  `(data buffers at +${maxOff}, each ${bufLen} B)`)
    }

    return Buffer.from(koffi.decode(memPtr, cachedMemType) as Uint8Array)
  } catch {
    cachedMemType = null   // reset so we re-probe on the next poll
    return null
  }
}

function buildVarMap(buf: Buffer): void {
  varMap.clear()
  const numVars  = buf.readInt32LE(HDR.NUM_VARS)
  const hdrStart = buf.readInt32LE(HDR.VAR_HDR_OFFSET)
  for (let i = 0; i < numVars; i++) {
    const base  = hdrStart + i * VARHDR_STRIDE
    const type  = buf.readInt32LE(base + VARHDR.TYPE)
    const offset = buf.readInt32LE(base + VARHDR.OFFSET)
    const count  = buf.readInt32LE(base + VARHDR.COUNT)
    // Name is a null-terminated char[32]
    const nameStart = base + VARHDR.NAME
    const nullAt = buf.indexOf(0, nameStart)
    const nameEnd = nullAt === -1 || nullAt > nameStart + 32 ? nameStart + 32 : nullAt
    const name = buf.subarray(nameStart, nameEnd).toString('ascii')
    if (name) varMap.set(name, { type, offset, count })
  }
  carCapabilities = {
    hasTractionControl: varMap.has('dcTractionControl'),
    hasABS:             varMap.has('dcABS'),
  }
  // Tire temps: iRacing only exposes carcass (internal structure) temps via
  // the SDK — `LFtempCL/CM/CR` per corner. Live "surface" / contact-patch
  // temps shown in iRacing's in-car display are computed internally and not
  // pumped through shared memory. Confirmed empirically across Porsche 911
  // GT3 R, Porsche 992 Cup, and corroborated by iRacing's published docs
  // (#69). Read carcass directly; the TireTemps overlay header is labelled
  // "PIT TIRE TEMPS" so the slow-update nature is obvious to the driver.
  console.log(`[irsdk] built var map — ${varMap.size} variables` +
    (carCapabilities.hasTractionControl ? ', TC' : '') +
    (carCapabilities.hasABS ? ', ABS' : ''))

  // ── Diagnostic for #64 (temporary) ─────────────────────────────────────────
  // Note which cockpit-state variables are present in this iRacing build.
  // The bug report says overlays no longer hide when leaving the cockpit, but
  // static analysis showed our `IsOnTrack` read + downstream wiring are intact
  // — so the most likely cause is that `IsOnTrack`'s semantics in this iRacing
  // build aren't quite what we assumed (e.g. it stays high in the get-in-car
  // screen). Logging the presence of related vars here, and the live values on
  // every state change in extractTelemetry(), lets us see the real bit pattern
  // and choose the right composite check for the fix. Remove once #64 lands.
  console.log('[irsdk-cockpit-debug] var presence —',
    'IsOnTrack=' + varMap.has('IsOnTrack'),
    'IsInGarage=' + varMap.has('IsInGarage'),
    'IsReplayPlaying=' + varMap.has('IsReplayPlaying'),
    'IsOnTrackCar=' + varMap.has('IsOnTrackCar'),
  )
}

function parseSessionYaml(buf: Buffer): void {
  const off = buf.readInt32LE(HDR.SESSION_INFO_OFF)
  const len = buf.readInt32LE(HDR.SESSION_INFO_LEN)
  const raw = buf.subarray(off, off + len).toString('utf-8').replace(/\0.*$/s, '')
  try {
    const doc = yaml.load(raw) as Record<string, unknown>
    if (!doc) return

    cachedPlayerCarIdx = (doc?.DriverInfo as any)?.DriverCarIdx ?? 0
    cachedRedLine      = Number((doc?.DriverInfo as any)?.DriverCarRedLine ?? 0)

    // All sessions in this event (we pick by live SessionNum)
    const sessions: unknown[] = (doc?.SessionInfo as any)?.Sessions ?? []
    sessionYamlTypes = sessions.map((s: any) => ({
      num:  Number(s.SessionNum ?? -1),
      type: mapSessionType(String(s.SessionType ?? '')),
    }))

    // Driver list — exclude only the pace car; include AI drivers so their name
    // and car number show correctly in the relative overlay.
    const drivers: unknown[] = (doc?.DriverInfo as any)?.Drivers ?? []
    cachedDrivers = (drivers as any[])
      .filter((d) => !d.CarIsPaceCar)
      .map((d) => ({
        carIdx:       Number(d.CarIdx ?? 0),
        userName:     String(d.UserName ?? ''),
        iRating:      Number(d.IRating ?? 0),
        safetyRating: String(d.LicString ?? ''),
        carNumber:    String(d.CarNumber ?? ''),
        carName:      String(d.CarPath ?? ''),
        isAI:         Boolean(d.CarIsAI),
      } satisfies DriverInfo))

    const aiCount = cachedDrivers.filter((d) => d.isAI).length
    console.log(`[irsdk] session YAML refreshed — ${cachedDrivers.length} drivers` +
      (aiCount ? ` (${aiCount} AI)` : '') +
      `, player car ${cachedPlayerCarIdx}`)
  } catch (e) {
    console.warn('[irsdk] YAML parse error:', e)
  }
}

function mapSessionType(raw: string): SessionType {
  const s = raw.toLowerCase()
  if (s.includes('practice') || s.includes('test')) return 'practice'
  if (s.includes('qual')) return 'qualifying'
  if (s.includes('race') || s.includes('time trial')) return 'race'
  return 'unknown'
}

/** Offset of the most recently completed data buffer within the mapped file. */
function latestDataOffset(buf: Buffer): number {
  let bestTick = -1
  let bestOff  = 0
  for (let i = 0; i < 4; i++) {
    const base = HDR.VARBUF_START + i * VARBUF_STRIDE
    if (base + 8 > buf.length) continue
    const tick = buf.readInt32LE(base + VARBUF_TICKCOUNT)
    const off  = buf.readInt32LE(base + VARBUF_OFFSET)
    // Only accept a buffer offset that actually fits inside what we mapped
    if (tick > bestTick && off > 0 && off < buf.length) {
      bestTick = tick
      bestOff  = off
    }
  }
  return bestOff
}

// Typed read helpers — return 0/false if the variable isn't in the var map or offset is out of range
function rf(buf: Buffer, base: number, name: string): number {
  const v = varMap.get(name); if (!v) return 0
  const off = base + v.offset; return off + 4 <= buf.length ? buf.readFloatLE(off) : 0
}
function rd(buf: Buffer, base: number, name: string): number {
  const v = varMap.get(name); if (!v) return 0
  const off = base + v.offset; return off + 8 <= buf.length ? buf.readDoubleLE(off) : 0
}
function ri(buf: Buffer, base: number, name: string): number {
  const v = varMap.get(name); if (!v) return 0
  const off = base + v.offset; return off + 4 <= buf.length ? buf.readInt32LE(off) : 0
}
/** irsdk_bool is 1 byte — do NOT use readInt32LE for bool variables */
function rb(buf: Buffer, base: number, name: string): boolean {
  const v = varMap.get(name); if (!v) return false
  const off = base + v.offset; return off < buf.length ? buf.readUInt8(off) !== 0 : false
}
function rfArr(buf: Buffer, base: number, name: string, len: number): number[] {
  const v = varMap.get(name)
  if (!v) return Array(len).fill(0)
  return Array.from({ length: len }, (_, i) => {
    const off = base + v.offset + i * 4
    return off + 4 <= buf.length ? buf.readFloatLE(off) : 0
  })
}
function riArr(buf: Buffer, base: number, name: string, len: number): number[] {
  const v = varMap.get(name)
  if (!v) return Array(len).fill(0)
  return Array.from({ length: len }, (_, i) => {
    const off = base + v.offset + i * 4
    return off + 4 <= buf.length ? buf.readInt32LE(off) : 0
  })
}

function extractTelemetry(buf: Buffer): IRacingTelemetry {
  const D = latestDataOffset(buf)  // base offset for this tick's data buffer

  const sessionNum   = ri(buf, D, 'SessionNum')
  const sessionState = ri(buf, D, 'SessionState') // 4 = actively racing

  const sessionEntry = sessionYamlTypes.find(s => s.num === sessionNum)
  const sessionType: SessionType = sessionEntry?.type ?? 'unknown'

  const positions    = riArr(buf, D, 'CarIdxPosition',    MAX_CARS)
  const lapDistPcts  = rfArr(buf, D, 'CarIdxLapDistPct',  MAX_CARS)
  const surfaces     = riArr(buf, D, 'CarIdxTrackSurface',MAX_CARS)
  const carLaps      = riArr(buf, D, 'CarIdxLap',         MAX_CARS)
  const f2Times      = rfArr(buf, D, 'CarIdxF2Time',      MAX_CARS)
  const lastLaps     = rfArr(buf, D, 'CarIdxLastLapTime', MAX_CARS)
  const bestLaps     = rfArr(buf, D, 'CarIdxBestLapTime', MAX_CARS)

  // Capture grid positions once at race start (sessionState 4 = racing, lap 0)
  if (sessionType === 'race' && sessionState === 4 && !startPositions.size) {
    positions.forEach((pos, idx) => { if (pos > 0) startPositions.set(idx, pos) })
  }
  if (sessionType !== 'race') startPositions.clear()

  const cars: CarTelemetry[] = []
  for (let idx = 0; idx < MAX_CARS; idx++) {
    const pos = positions[idx]
    const surf = surfaces[idx]
    // irsdk_TrkLoc enum: -1=NotInWorld, 0=OffTrack, 1=InPitStall, 2=AproachingPits, 3=OnTrack
    if (surf === -1) continue                    // not spawned into the world
    const onTrack = surf === 3
    const inPit   = surf === 1 || surf === 2
    if (pos === 0 && !onTrack && !inPit) continue  // off-track, unpositioned — skip
    cars.push({
      carIdx:        idx,
      position:      pos,
      lapDistPct:    lapDistPcts[idx],
      lap:           carLaps[idx],
      onTrack,
      inPit,
      lastLapTime:   lastLaps[idx],
      bestLapTime:   bestLaps[idx],
      f2Time:        f2Times[idx],
      startPosition: startPositions.get(idx) ?? pos,
    })
  }

  // ── Diagnostic for #64 (temporary) ─────────────────────────────────────────
  // Read all four "is the driver actually driving?" signals and log on every
  // state change so we can see which bit iRacing flips on exit-to-garage /
  // get-in-car / replay. Used to drive the real fix in a follow-up PR.
  const cockpit: CockpitDebugState = {
    isOnTrack:       rb(buf, D, 'IsOnTrack'),
    isInGarage:      varMap.has('IsInGarage')      ? rb(buf, D, 'IsInGarage')      : null,
    isReplayPlaying: varMap.has('IsReplayPlaying') ? rb(buf, D, 'IsReplayPlaying') : null,
    isOnTrackCar:    varMap.has('IsOnTrackCar')    ? rb(buf, D, 'IsOnTrackCar')    : null,
    playerSurface:   surfaces[cachedPlayerCarIdx] ?? -1,
  }
  logCockpitDelta(cockpit)

  return {
    connected:          true,
    // IsOnTrack is true only when the driver is in their cockpit and the
    // session is live — false in garage, get-in-car screen, replays, and
    // spectator mode. Used by overlays to hide when not actively driving.
    isOnTrack:          cockpit.isOnTrack,
    sessionType,
    sessionTime:        rd(buf, D, 'SessionTime'),
    sessionTimeRemain:  rd(buf, D, 'SessionTimeRemain'),
    // `SessionLapsRemain` is reliable in lap-counted races and a sentinel
    // (typically `-1`) in timed races until the leader crosses the line at
    // the end of time.  Surface it raw and let the consumer guard — see
    // `PitStrategy/lib.ts` for the canonical [1, 9999] usable-range check.
    // `varMap.has()` guard mirrors how we handle ShiftIndicatorPct so
    // missing-on-this-build returns -1 (the "not available" sentinel) rather
    // than 0 (which would look like a finished race).
    sessionLapsRemain:  varMap.has('SessionLapsRemain') ? ri(buf, D, 'SessionLapsRemain') : -1,
    // `SessionState`: irsdk enum — 0 Invalid, 1 GetInCar, 2 Warmup,
    // 3 ParadeLaps, 4 Racing, 5 Checkered, 6 CoolDown. Surface raw so
    // overlays (PitStrategy, in particular) can latch on `>= 5` to know
    // the race has ended for the field, independent of how
    // `SessionLapsRemain` behaves post-checkered. See #70 follow-up.
    sessionState:       sessionState,
    playerCarIdx:       cachedPlayerCarIdx,
    playerCarRedLine:   cachedRedLine,
    // `ShiftIndicatorPct` may not be present on every car / build of the SDK.
    // `rf` returns 0 on miss, which would be indistinguishable from "low revs"
    // — so check the var map directly and surface NaN to the overlay when the
    // field is unavailable, letting it fall back to the percentage heuristic.
    shiftIndicatorPct:  varMap.has('ShiftIndicatorPct') ? rf(buf, D, 'ShiftIndicatorPct') : NaN,
    speed:              rf(buf, D, 'Speed'),
    gear:               ri(buf, D, 'Gear'),
    rpm:                rf(buf, D, 'RPM'),
    throttle:           rf(buf, D, 'Throttle'),
    brake:              rf(buf, D, 'Brake'),
    fuelLevel:          rf(buf, D, 'FuelLevel'),
    fuelUsePerHour:     rf(buf, D, 'FuelUsePerHour'),
    lap:                ri(buf, D, 'Lap'),
    lapCurrentLapTime:  rf(buf, D, 'LapCurrentLapTime'),
    lapLastLapTime:     rf(buf, D, 'LapLastLapTime'),
    lapBestLapTime:     rf(buf, D, 'LapBestLapTime'),
    // Delta: only valid once a reference lap exists (irsdk_bool = 1 byte)
    lapDeltaToBestLap:  rb(buf, D, 'LapDeltaToBestLap_OK')
                          ? rf(buf, D, 'LapDeltaToBestLap')
                          : NaN,
    lapDistPct:         rf(buf, D, 'LapDistPct'),
    // Tire temps °C — inner/middle/outer zone per corner. iRacing exposes
    // only carcass temps (internal structure) via the SDK; live contact-patch
    // ("surface") temps shown in the in-car display are computed internally
    // and not pumped through shared memory (verified empirically + via
    // iRacing docs, #69). Values update slowly while driving; most visible
    // during pit stops. The TireTemps overlay header is "PIT TIRE TEMPS" so
    // the slow-update nature is communicated to the driver.
    tireLF: [rf(buf, D, 'LFtempCL'), rf(buf, D, 'LFtempCM'), rf(buf, D, 'LFtempCR')] as const,
    tireRF: [rf(buf, D, 'RFtempCL'), rf(buf, D, 'RFtempCM'), rf(buf, D, 'RFtempCR')] as const,
    tireLR: [rf(buf, D, 'LRtempCL'), rf(buf, D, 'LRtempCM'), rf(buf, D, 'LRtempCR')] as const,
    tireRR: [rf(buf, D, 'RRtempCL'), rf(buf, D, 'RRtempCM'), rf(buf, D, 'RRtempCR')] as const,
    carLeftRight: ri(buf, D, 'CarLeftRight'),
    tc: {
      // dcTractionControl is the driver-adjustable dial (0 = off).
      // TractionControlActive is true while the system is intervening.
      level:  rf(buf, D, 'dcTractionControl'),
      active: rb(buf, D, 'TractionControlActive'),
    },
    abs: {
      // dcABS is the driver-adjustable ABS level (0 = off).
      // BrakeABSactive fires when ABS is intervening (variable name varies by car).
      level:  rf(buf, D, 'dcABS'),
      active: rb(buf, D, 'BrakeABSactive'),
    },
    cars,
    drivers:      cachedDrivers,
    capabilities: carCapabilities,
  }
}

const DISCONNECTED: IRacingTelemetry = {
  connected: false, isOnTrack: false, sessionType: 'unknown',
  sessionTime: 0, sessionTimeRemain: 0, sessionLapsRemain: -1, sessionState: 0,
  playerCarIdx: 0, playerCarRedLine: 0,
  shiftIndicatorPct: NaN,
  speed: 0, gear: 0, rpm: 0, throttle: 0, brake: 0,
  fuelLevel: 0, fuelUsePerHour: 0,
  lap: 0, lapCurrentLapTime: 0, lapLastLapTime: 0, lapBestLapTime: 0,
  lapDeltaToBestLap: NaN, lapDistPct: 0,
  tireLF: [0, 0, 0], tireRF: [0, 0, 0], tireLR: [0, 0, 0], tireRR: [0, 0, 0],
  carLeftRight: 0,
  tc:  { level: 0, active: false },
  abs: { level: 0, active: false },
  cars: [], drivers: [],
  capabilities: { hasTractionControl: false, hasABS: false },
}
