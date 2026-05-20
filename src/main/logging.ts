// Centralised log-level management (issue #50).
//
// Three concerns live here so callers don't have to think about them:
//   1. **Build-tier default** — what level to write at when the user hasn't
//      overridden anything.  Detected from `app.isPackaged` + the running
//      version's prerelease tag:
//        • Dev (`npm run dev`):              `debug` — full firehose.
//        • Prerelease (`npm run dist:pre …`): `info`  — useful but quiet.
//        • Stable (`npm run dist`):          `warn`  — only when something
//                                                       actually goes wrong.
//   2. **User override** — persisted in `userData/log-level.json` so dev /
//      support sessions can bump verbosity at runtime via the Perf HUD
//      without rebuilding.  Survives restarts; can be reset to default.
//   3. **electron-log application** — applies the resolved level to both the
//      file and console transports, and broadcasts state changes so renderers
//      (Perf HUD, Updates pane) can react.
//
// This module owns `electronLog.initialize()` so callers like
// `src/main/updater.ts` can just import the scoped logger and not re-init.

import { app, shell } from 'electron'
import { join, dirname } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import electronLog from 'electron-log/main'

/** All electron-log levels we expose in the UI.  Ordered from quietest to
 *  loudest so the segmented control in the Perf HUD reads naturally. */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** Categorisation of the running build.  Driven entirely by static
 *  properties (packaged + version string) so detection is deterministic. */
export type BuildTier = 'dev' | 'prerelease' | 'stable'

/** Snapshot of the logging system's current state, surfaced to renderers
 *  via `log:getState` IPC and broadcast on `log:level-changed`. */
export interface LogLevelState {
  /** Currently-applied level — what electron-log is actually using. */
  level: LogLevel
  /** What the level would be if no user override were in effect.  Used by
   *  the Perf HUD's "Default: X (build-tier)" label and Reset button. */
  default: LogLevel
  /** Which build tier the running process was detected as. */
  buildTier: BuildTier
  /** True iff the level differs from the build-tier default because the
   *  user explicitly set it — controls whether the Reset button appears. */
  isOverride: boolean
}

// ── Private state ───────────────────────────────────────────────────────────

let broadcast: ((channel: string, data: unknown) => void) | null = null
let currentLevel: LogLevel = 'warn'
let userOverride: LogLevel | null = null
let initialized = false

function overridePath(): string {
  return join(app.getPath('userData'), 'log-level.json')
}

function detectBuildTier(): BuildTier {
  if (!app.isPackaged) return 'dev'
  // A semver version with a prerelease tag always contains `-` (e.g.
  // `0.1.0-autoUpdateTest.3`); clean stable versions never do.  Cheaper
  // and more obvious than pulling in the `semver` package.
  if (app.getVersion().includes('-')) return 'prerelease'
  return 'stable'
}

function defaultLevelFor(tier: BuildTier): LogLevel {
  switch (tier) {
    case 'dev':        return 'debug'
    case 'prerelease': return 'info'
    case 'stable':     return 'warn'
  }
}

function isValidLevel(s: unknown): s is LogLevel {
  return typeof s === 'string' && (LOG_LEVELS as readonly string[]).includes(s)
}

function loadOverride(): LogLevel | null {
  const p = overridePath()
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8')) as { level?: unknown }
    return isValidLevel(data?.level) ? data.level : null
  } catch {
    return null
  }
}

function saveOverride(level: LogLevel | null): void {
  const p = overridePath()
  if (level === null) {
    // Best-effort delete — file may not exist if user hits Reset before
    // ever setting an override.
    try { unlinkSync(p) } catch {}
    return
  }
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify({ level }, null, 2), 'utf-8')
}

function applyLevel(level: LogLevel): void {
  currentLevel = level
  electronLog.transports.file.level    = level
  electronLog.transports.console.level = level
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Initialise electron-log, detect the build tier, apply the user override
 *  (if any) or the build-tier default.  Must be called once at app-ready,
 *  before any module that wants to write logs — including `updater.ts`. */
export function initLogging(
  broadcastFn: (channel: string, data: unknown) => void,
): void {
  if (initialized) {
    // Safe to call again (e.g. test reset) but only the broadcaster updates.
    broadcast = broadcastFn
    return
  }
  initialized = true
  broadcast = broadcastFn

  electronLog.initialize()

  // Route every main-process `console.log / .info / .warn / .error / .debug`
  // call through electron-log's transports so they land in `main.log`
  // (#73).  Without this, only `electronLog.info(...)` / `electronLog.scope(...)`
  // calls reach the file — plain `console.log` lines (`[irsdk] built var map`,
  // the per-tick diagnostics added in PR #65, etc.) were only printed to the
  // dev terminal and effectively lost for packaged builds.
  //
  // `electronLog.functions` is an object of `{ log, info, warn, error, debug,
  // verbose, silly }` methods that respect the configured transports + level.
  // Assigning them onto `console` is the documented v5 recipe for capturing
  // ambient console output.  Third-party libraries that log via `console.*`
  // are captured too, which is intentional — we want koffi / electron-builder
  // / etc. errors in the support bundle when something goes wrong.
  Object.assign(console, electronLog.functions)

  userOverride = loadOverride()
  const tier = detectBuildTier()
  const effective = userOverride ?? defaultLevelFor(tier)
  applyLevel(effective)

  // Use the bare (unscoped) logger here so this initial line is unambiguous
  // about coming from the logging-system itself, not a consumer module.
  electronLog.info(
    `[logging] init — tier=${tier} default=${defaultLevelFor(tier)} ` +
    `override=${userOverride ?? 'none'} effective=${effective} ` +
    `version=${app.getVersion()} packaged=${app.isPackaged}`,
  )
}

/** Snapshot of the current logging state.  Cheap; safe to call from IPC
 *  handlers on every renderer request. */
export function getLogLevelState(): LogLevelState {
  const tier = detectBuildTier()
  return {
    level:      currentLevel,
    default:    defaultLevelFor(tier),
    buildTier:  tier,
    isOverride: userOverride !== null,
  }
}

/** Apply a user override.  Persists to disk so it survives restarts.
 *  Broadcasts `log:level-changed` so renderers can re-render. */
export function setLogLevel(level: LogLevel): void {
  if (!isValidLevel(level)) return
  userOverride = level
  saveOverride(level)
  applyLevel(level)
  broadcast?.('log:level-changed', getLogLevelState())
}

/** Clear any user override and revert to the build-tier default.  Removes
 *  the override file so future launches don't re-load it. */
export function resetLogLevel(): void {
  userOverride = null
  saveOverride(null)
  applyLevel(defaultLevelFor(detectBuildTier()))
  broadcast?.('log:level-changed', getLogLevelState())
}

/** Absolute path of the active log file. */
export function getLogPath(): string {
  return electronLog.transports.file.getFile().path
}

/** Folder containing the log files (electron-log can rotate, so the parent
 *  directory is the more useful "show me my logs" target). */
export function getLogFolder(): string {
  return dirname(getLogPath())
}

/** Open the log folder in the OS file browser.  Returns an empty string on
 *  success or an error message on failure (per the `shell.openPath` API). */
export function openLogFolder(): Promise<string> {
  return shell.openPath(getLogFolder())
}
