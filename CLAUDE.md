# RaceLayer — CLAUDE.md

> **Documentation rule:** Whenever code changes are made in this repo — new features, bug fixes, config additions, SDK variable discoveries — update this file and `README.md` in the same commit. The goal is for `CLAUDE.md` to always reflect the actual state of the codebase so future sessions can onboard instantly without re-deriving context from reading source files.

> **Branch policy:** `main` tracks the **latest released code** — every merge into `main` is a release moment. `main` requires a pull request; direct pushes are blocked. The workflow uses three branch kinds plus an occasional fourth:
>
> | Branch | Purpose | Cut from | Merges to |
> |---|---|---|---|
> | `main` | Latest released code (one commit per release) | n/a | n/a |
> | `release/vX.Y.Z` | Staging area for the next release; one active at a time | `main` (when the release is opened) | `main` (at release time) |
> | `feat/short-name` | One feature or fix at a time | `main` | active `release/vX.Y.Z` |
> | `hotfix/vX.Y.Z` | Urgent patch against a shipped release | `main` | `main`, then forward-merge into active `release/*` |
>
> **Why this shape:** features get smaller, more focused PRs into the release branch; pre-release builds can be cut from `release/*` without disturbing `main`; `main`'s history reads as a release log. One release branch is open at a time so feature targeting stays simple.
>
> **Every PR must reference a GitHub issue.** The issue captures the *why* (problem, desired behaviour, acceptance criteria); the PR captures the *how* (implementation). Before starting a feature, either pick an existing issue or open one. The PR body must include `Closes #N` (or `Fixes #N` / `Resolves #N`) so the issue auto-closes on merge and the link is visible from both views. If no issue exists yet when the user describes a task, the assistant should propose one (title + acceptance criteria) and confirm with the user before opening it. **Exception:** trivial behaviour-preserving PRs (typo fixes, formatting) may skip the issue.
>
> **Start-of-session recipe** — always branch features from `main`, not from the active release branch:
> ```bash
> git checkout main && git pull
> git checkout -b feat/your-feature-name
> # ... build and commit ...
>
> # When ready to open the PR, rebase onto the active release branch
> git fetch origin
> git rebase origin/release/v0.1.3   # whichever release is open
> git push -u origin feat/your-feature-name
> # Open PR: feat/your-feature-name → release/v0.1.3 (NOT main)
> ```
> Branching from `main` keeps features release-agnostic — a feature that doesn't ship with the active release can simply be retargeted to the next one without re-baselining.
>
> **Escape hatch:** if a feature depends on changes already accepted into the active release branch (e.g. extending a config type another in-flight feature added), branch from `release/vX.Y.Z` directly instead. This should be rare; the strong default is `main`.
>
> **Opening a new release branch** — done by the release manager when the next release is ready to start accumulating features:
> ```bash
> git checkout main && git pull
> git checkout -b release/v0.1.3
> # Bump version in package.json + CLAUDE.md to 0.1.3 in the same commit that creates the branch
> git push -u origin release/v0.1.3
> ```
> Bumping the version at branch creation means every feature merging into the release sees the right version number; pre-release builds can be tagged as `v0.1.3-beta.N` directly off the release branch.
>
> **Tagging conventions:**
> - **Stable releases** (`v0.1.3`) are tagged on the merge commit on `main` after the release-branch PR lands.
> - **Pre-release builds** (`v0.1.3-beta.1`, `v0.1.3-rc.1`) are tagged on the `release/v0.1.3` branch itself. Mark these as `--prerelease` on GitHub and **do not upload `latest.yml`** for them, or stable users would be offered the beta via `electron-updater`.
>
> **Hotfix flow:**
> ```bash
> git checkout main && git pull
> git checkout -b hotfix/v0.1.2.1
> # Fix, bump patch version, commit
> git push -u origin hotfix/v0.1.2.1
> # Open PR: hotfix/* → main
> # After merge + tag + release: forward-merge main into the active release branch
> git checkout release/v0.1.3 && git pull
> git merge main && git push
> ```
>
> **Issue lifecycle through the release cycle:** Linked issues do **not** auto-close when their PR merges into a `release/v*` branch — GitHub's native `Closes #N` only fires on merge to the default branch. Instead, the `Label Merged Issues` workflow applies the `ready-to-release` label to each referenced issue on release-branch merge, so the milestone view stays useful:
>
> - **Open + unlabeled** → work not yet merged
> - **Open + `ready-to-release`** → code merged, awaiting release
> - **Closed** → shipped to users
>
> Filter the backlog with `is:open -label:ready-to-release` to see only actively-pending work.
>
> When the `release/v* → main` PR merges, the `ready-to-release` issues for that milestone auto-close — feature PRs are squash-merged into the release branch with their `Closes #N` keywords preserved in the squash commit message, and the release-branch PR merges into main as a **merge commit** (`gh pr merge --merge`, not `--squash`) so those individual commits arrive on main intact. GitHub scans commit messages on the default branch and closes the referenced issues. If a stray issue remains open after the release lands (the linked PR didn't include a `Closes #N` keyword), close it by hand:
>
> ```bash
> gh issue close <num> --reason completed
> ```
>
> **Branch naming:** keep names short and conventional-commits-aligned — `feat/closing-rate`, `fix/pit-mode-gap`, `chore/branch-policy-update`. Release branches always carry the `v` prefix to match git tags: `release/v0.1.3`, never `release/0.1.3`.
>
> **Branch cleanup after merge:** When a PR merges, `gh pr merge --delete-branch` removes the *remote* branch on origin, but the local copy sticks around. Without periodic cleanup the local branch list balloons (this repo accumulated ~20 stale branches across ~6 releases before #61 surfaced it). Run this after any merge — feature, release, finalize, hotfix:
>
> ```bash
> git fetch --prune
> git branch -vv | grep ': gone]' | awk '{print $1}' | xargs -r git branch -d
> ```
>
> `git fetch --prune` removes the remote-tracking refs for branches deleted on origin; `git branch -vv` flags each local branch whose upstream now reads `[gone]`; `git branch -d` (lowercase, safe) deletes them and refuses any that still have unmerged commits. Use `-D` (capital, force) only if you're sure. Set `git config --global fetch.prune true` to make the first step run automatically on every fetch.
>
> PowerShell equivalent (this repo is Windows-only, so this is the form you'll usually want):
>
> ```powershell
> git fetch --prune
> git branch -vv | Select-String ': gone]' | ForEach-Object { ($_ -split '\s+')[1] } | ForEach-Object { git branch -d $_ }
> ```
>
> Worth running at the end of every `/release` run in particular — a release flushes a finalize branch + the release branch + any feature branches that landed, all of which become stale once `main` has the tag.
>
> **Release-notes enforcement:** Every PR targeting a `release/v*` branch must modify the corresponding `release-notes/vX.Y.Z.md` file. Enforced by the `Require Release Notes` GitHub Action (`.github/workflows/require-release-notes.yml`). Bypass with the `no-release-notes` label on the PR for pure refactors or behaviour-preserving changes where `Internal: (none)` is the honest answer — the workflow re-runs on label add/remove, so applying the label turns the failing check green without a force-push.
>
> **Testing:** Two complementary layers.
>
> - **Automated unit tests** live in `tests/**/*.test.ts` and run via Vitest (`npm test` / `npm run test:watch`). Scope is **pure logic only** — telemetry parsing, derived calculations (closing-rate regression, stint detection, tire-deg trend), formatters, `mergeWithDefaults`. No Electron, no React rendering, no jsdom. The pure logic for each overlay lives in a sibling `lib.ts` next to the component (`PitStrategy/lib.ts`, `Relative/lib.ts`, `Gauges/lib.ts`) — components import from `./lib` so the test suite exercises the exact code that runs at render time. The `Test` GitHub Action runs the suite on every PR and on pushes to `main` / `release/v*`.
> - **Manual test plan** lives in `docs/test-plan.md` and covers everything the unit tests can't: real-vs-mock telemetry behaviour, pit mode, disconnect/reconnect, session-type switching, overlay rendering, drag/edit mode, settings, the in-app updater. Includes a 5-minute pre-release smoke loop and a full pass for stable releases. Walk through the relevant sections before merging a release-branch PR into `main`.
>
> When adding a new feature with derived logic, put the logic in the overlay's `lib.ts` and add a unit test in the same PR. When changing user-visible behaviour, also update `docs/test-plan.md` so the manual checklist stays accurate.
>
> **PR template** (`.github/pull_request_template.md`) pre-fills the Summary / Why / Test plan / Checklist scaffolding and reminds authors to link the issue, update release notes, and run the relevant tests. GitHub injects it automatically when opening a PR via the web UI; `gh pr create` will use it too unless you pass `--body`.

## What This Is

An Electron + React overlay application that renders real-time telemetry from iRacing onto a transparent, always-on-top window. Built for Windows. Each overlay is its own `BrowserWindow` (transparent, frameless, `alwaysOnTop: screen-saver`). A tray icon and Settings window are the only non-overlay UI.

App name: **RaceLayer** | Package name: `racelayer` | Version: `1000.0.0`
GitHub: `https://github.com/oiddad/racelayer`

## Project Structure

```
iracing-overlay/
├── src/
│   ├── main/                  # Electron main process (Node.js)
│   │   ├── index.ts           # App entry: creates windows, tray, IPC, polling loop
│   │   ├── iracingSdk.ts      # iRacing shared-memory reader via koffi FFI
│   │   ├── telemetry.ts       # Polling loop + IRacingTelemetry type (main-side)
│   │   ├── mockTelemetry.ts   # Simulated data for preview mode
│   │   ├── config.ts          # Overlay config persistence (per-user JSON files)
│   │   ├── previewMode.ts     # Preview mode state (enable/disable + session type)
│   │   └── shortcuts.ts       # Global keyboard shortcuts (register/update/save)
│   ├── preload/
│   │   └── index.ts           # contextBridge — exposes window.iracingOverlay API
│   └── renderer/src/          # React frontend (Vite, TypeScript)
│       ├── App.tsx            # HashRouter routes: one route per overlay + /settings
│       ├── main.tsx           # React entry point
│       ├── contexts/
│       │   ├── TelemetryContext.tsx      # Subscribes to telemetry:update IPC events
│       │   └── OverlayConfigContext.tsx  # Loads/saves overlay config via IPC
│       ├── hooks/
│       │   ├── useDrag.ts     # Custom drag via window:getBounds / window:setBounds IPC
│       │   └── useEditMode.ts # Listens for overlay:editMode broadcast
│       ├── overlays/
│       │   ├── Gauges/        # RPM bar, input trace, gear, speed, delta, fuel
│       │   ├── Relative/      # Proximity list (position, gap, iR, SR, pos Δ, est. iR Δ)
│       │   ├── PitStrategy/   # Fuel calc, tire deg history, pit window
│       │   ├── TireTemps/     # 4-corner temp display with color coding
│       │   └── Radar/         # Disabled (code kept for future revisit)
│       ├── pages/
│       │   └── Settings/      # Settings window: preview mode, shortcuts, overlay config
│       └── types/
│           ├── telemetry.ts   # IRacingTelemetry, CarTelemetry, DriverInfo, SessionType
│           ├── overlayConfig.ts  # OverlayConfig type, defaults, mergeWithDefaults
│           ├── config.ts      # (legacy config type, may overlap overlayConfig)
│           └── global.d.ts    # window.iracingOverlay type declaration
├── resources/                 # App icons (icon.png, icon.ico, icon-tray.png)
├── scripts/
│   └── generate-icons.mjs    # Generates icon.png at multiple sizes + icon.ico
├── electron.vite.config.ts   # Electron-Vite build config
├── electron-builder.json5    # Packaging config (NSIS + portable, GitHub Releases)
└── package.json
```

## Running Locally

```bash
# Dev (hot-reload, opens all overlay windows + settings)
npm run dev

# Type check only
npx tsc --noEmit

# Run pure-logic unit tests (Vitest)
npm test            # one-shot
npm run test:watch  # watch mode

# Build + package (produces NSIS installer + portable .exe)
npm run dist

# Build without packaging (for testing the built output)
npm run dist:dir

# Build a pre-release package (version override only — package.json unchanged)
# Produces e.g. RaceLayer-0.1.3-beta.1.exe in dist/
# Upload to a GitHub --prerelease release; do NOT upload latest.yml or stable
# users will be offered this build via auto-update.
npm run dist:pre -- beta.1
npm run dist:pre -- rc.2

# Regenerate app icons from scratch
npm run icons

# Release pipeline scripts (invoked by the /release skill — see scripts/release/*.mjs)
# All four accept --dry-run to validate preconditions without mutating anything.
npm run release:finalize  -- vX.Y.Z   # opens & lands chore/finalize-vX.Y.Z PR (steps 3-4)
npm run release:promote   -- vX.Y.Z   # opens release -> main PR, merges, tags (steps 5-7)
npm run release:publish   -- vX.Y.Z   # npm run dist + GH release + uploads (steps 9-11)
npm run release:open-next -- vX.Y.Z   # branches release/vX.Y.Z, scaffolds notes, milestone (step 13)
```

iRacing must be running for real telemetry. Use **Preview Mode** (Settings → Preview Mode) to show overlays with simulated data without iRacing.

## Tech Stack

- **Electron** (main process) — window management, IPC, tray, global shortcuts
- **Vite + React 19 + TypeScript** (renderer) — overlay UIs, Settings page
- **CSS Modules** — each overlay has its own `*.module.css`
- **koffi** — FFI library to call Win32 APIs from Node.js (no native compilation needed)
- **electron-vite** — unified build tool for Electron + Vite
- **electron-builder** — packaging to NSIS installer + portable `.exe`

## Architecture Patterns

### How Overlays Work

Each overlay is a separate `BrowserWindow` — transparent, frameless, `alwaysOnTop: 'screen-saver'`, `setIgnoreMouseEvents(true, { forward: true })`. All windows load the same renderer (`index.html`) at different hash routes (`#/relative`, `#/gauges`, etc.).

Overlays are **hidden by default** and only shown (`showInactive()`) when iRacing reports connected. They're hidden again when iRacing disconnects.

### IPC Channels

| Channel | Direction | Description |
|---|---|---|
| `telemetry:update` | main → renderer | Fired every poll tick (60ms) with full `IRacingTelemetry` |
| `overlay:editMode` | main → renderer | Broadcast when layout mode toggles |
| `previewMode:changed` | main → renderer | Broadcast on preview mode state change |
| `config:changed` | main → renderer | Broadcast when any overlay config saved |
| `config:get` | renderer → main | Load overlay config JSON |
| `config:set` | renderer → main | Save overlay config JSON + broadcast |
| `previewMode:get/set` | renderer → main | Read/write preview mode state |
| `shortcuts:get/set` | renderer → main | Read/update global shortcuts |
| `window:getBounds` | renderer → main | Get window's current `{x, y, width, height}` (used to lock size during drag) |
| `window:setBounds` | renderer → main | Move + resize window during custom drag — width/height are re-asserted every frame to prevent DPI-related size creep |
| `positions:reset` | renderer → main | Reset all overlay positions to defaults |
| `startup:get` | renderer → main | Returns `boolean` — whether app is registered as a login item |
| `startup:set` | renderer → main | Accepts `boolean` — registers or removes the Windows login item |
| `app:version` | renderer → main | Returns current app version string from `app.getVersion()` |
| `update:getStatus` | renderer → main | Returns current `UpdateStatus` object |
| `update:check` | renderer → main | Triggers `autoUpdater.checkForUpdates()` |
| `update:download` | renderer → main | Triggers `autoUpdater.downloadUpdate()` |
| `update:install` | renderer → main | Calls `autoUpdater.quitAndInstall()` |
| `app:openExternal` | renderer → main | Open an http(s) URL in the user's default browser via `shell.openExternal`. Main rejects non-http(s) schemes. |
| `update:status` | main → renderer | Broadcast on every update state transition |

### Telemetry Pipeline

1. `telemetry.ts` polls every ~60ms via `iracingSdk.ts`
2. `iracingSdk.ts` reads iRacing's Windows named memory-mapped file (`Local\IRSDKMemMapFileName`) using koffi FFI calls to `OpenFileMapping` / `MapViewOfFile`
3. Parses variable headers, builds `varMap`, reads typed values at byte offsets
4. Constructs `IRacingTelemetry` and passes to the callback in `index.ts`
5. `index.ts` calls `broadcastToOverlays('telemetry:update', telemetry)` to all overlay windows. (Two fan-out helpers exist in main: `broadcastToOverlays` for high-frequency overlay-only channels like `telemetry:update` / `overlay:editMode`, and `broadcastToAll` which additionally sends to the Settings window for state-change channels like `previewMode:changed` / `config:changed` / `update:status`. The Settings UI subscribes to the latter and would miss tray-driven state changes if they fanned through `broadcastToOverlays`.)
6. `TelemetryContext.tsx` in the renderer listens and stores in React state

Preview mode bypasses iRacing entirely — `mockTelemetry.ts` generates simulated data.

### Overlay Config System

All overlays share a single unified config stored as `overlays.json` in the user's Electron `userData` directory. The config is typed in `src/renderer/src/types/overlayConfig.ts`.

**Key types:**
```typescript
type SType = 'practice' | 'qualifying' | 'race'
type SessionFlags = Record<SType, boolean>  // per-session-type toggle
```

Every configurable element uses `SessionFlags` so each can be independently toggled per session type. New overlays added to the config must also add a branch in `mergeWithDefaults()` so saved configs from older versions get the new field's default value.

**`GlobalConfig`** contains settings that apply across all overlays:
```typescript
interface GlobalConfig {
  hideUnsupportedElements: boolean  // default: true
}
```
When `hideUnsupportedElements` is true, overlays and elements that require car-specific capabilities (TC, ABS) are automatically hidden when the current car doesn't expose those SDK variables. Each overlay is responsible for reading `config.global.hideUnsupportedElements` and gating itself. (TireTemps does NOT gate on this — every car exposes carcass temps; see "Tire temp variables" under SDK Notes.)

`OverlayConfigContext.tsx` loads config on mount, exposes `{ config, update }`. Each overlay reads from `useOverlayConfig()`.

**Important hook ordering:** All hooks (`useTelemetry`, `useOverlayConfig`, `useEditMode`, `useDrag`, `useMemo`, `useRef`, `useEffect`) must be called **before** any conditional `return null` — enforce Rules of Hooks. Use `visibility: hidden` instead of conditional rendering for optional grid columns to keep CSS grid layout stable.

### Window Position Persistence

Saved in `<userData>/config/overlays/positions_<monitorKey>.json` where `monitorKey` encodes the current display configuration (bounds + positions of all monitors joined by `_`). Positions include `x`, `y`, `width`, `height`. Separate layouts per monitor config — plugging in/out a monitor doesn't break saved positions.

Custom drag is implemented without `frame: true` drag — overlays use `setIgnoreMouseEvents` and pass `forward: true`, so mousedown events still reach the renderer. `useDrag` reads the window's current position via IPC, then sends new positions on `mousemove`.

## iRacing SDK Notes

**Shared memory:** `Local\IRSDKMemMapFileName` (named memory-mapped file, Windows only). The header describes variable offsets; `varMap` is built by parsing variable headers at startup.

**Tire temp variables:** iRacing exposes only **carcass** (internal structure) temps via the SDK — `LFtempCL/CM/CR`, `RFtempCL/CM/CR`, `LRtempCL/CM/CR`, `RRtempCL/CM/CR`. Per-corner: inner / middle / outer zone, °C. Verified empirically across Porsche 911 GT3 R, Porsche 992 Cup, and corroborated by iRacing's published docs (#69).

The "live" contact-patch (surface) temps shown in iRacing's in-car tire-temp app are computed internally and **not pumped through shared memory** — no `LFtempL/M/R` triplet, no equivalent under any other name. Don't try to read live surface temps; they're not there.

Carcass temps change slowly while driving (internal heat takes minutes to redistribute) and are most visible during pit stops. The TireTemps overlay headline is `"PIT TYRE TEMPS"` so the slow-update nature is communicated to the driver — there is no auto-hide based on a capability flag because there's nothing to hide behind: every car has carcass.

**Car capabilities** are detected once per connection in `buildVarMap()` and stored in a module-level `carCapabilities` variable:
```typescript
hasTractionControl: 'dcTractionControl' in varMap,
hasABS:             'dcABS' in varMap,
```
Capabilities are reset to `false` in `closeMemory()`. The renderer receives them as part of every `IRacingTelemetry` payload.

**CarIdxTrackSurface enum** (irsdk_TrkLoc):
- `-1` = NotInWorld (skip these cars)
- `0` = OffTrack
- `1` = InPitStall
- `2` = AproachingPits
- `3` = OnTrack ← use this for `onTrack: true`

**SessionState enum** (irsdk_SessionState — surfaced as `sessionState` on `IRacingTelemetry`):
- `0` = Invalid
- `1` = GetInCar
- `2` = Warmup
- `3` = ParadeLaps
- `4` = Racing ← use this to detect "actively racing"
- `5` = Checkered ← race over for the field
- `6` = CoolDown ← race over for the field

`>= 5` is the durable "race is done" signal. `SessionLapsRemain` is not safe to rely on for race-over detection — it can transition `1 → 0` during the player's final lap (#70) AND can revert to a stale positive integer once the cool-down session begins (#70 follow-up: a 9-lap race that finished with `SessionLapsRemain` resurfaced as `9`). Pit Strategy's `computeFuelStats()` latches `finishOnFuel = true` on `sessionState >= 5` so the green affordance can't flip back to "Pit in N laps" after the checkered.

**Position in practice:** `CarIdxPosition` returns `0` in practice sessions (no race classification). Show `--` instead of `P0`.

**f2Time:** `CarIdxF2Time` — seconds relative to player. Negative = car is ahead of player. **Unreliable in practice sessions** (returns 0 for cars without a set lap time). The Relative overlay replaces it with a `lapDistPct`-based calculation:
```typescript
function computeRelativeGap(car, playerLapDistPct, playerLap, referenceLapTime) {
  const diff = (car.lap + car.lapDistPct) - (playerLap + playerLapDistPct)
  const wrapped = diff - Math.round(diff)  // wraps to [-0.5, 0.5] shortest path
  return -wrapped * referenceLapTime
}
```
`referenceLapTime` is derived from the best lap of any car that has completed at least one lap, falling back to the SDK's `sessionTimeRemain / (totalLaps - currentLap)` estimate.

**AI drivers:** `CarIsAI: 1` in session YAML for all AI-controlled cars. Do **not** filter them out of the driver list — they have valid names, car numbers, and all their telemetry is meaningful. Only filter pace cars (`CarIsPaceCar: 1`).

**TC / ABS SDK variables:**
- `dcTractionControl` — float, current dial level (0 = off)
- `TractionControlActive` — bool, system currently intervening
- `dcABS` — float, current ABS dial level (0 = off)
- `BrakeABSactive` — bool, ABS currently intervening

**Fuel calc:** Don't use `fuelUsePerHour` for laps-remaining at rest (shows ~2 L/hr at idle = 1,300+ laps). Instead, measure actual fuel delta at lap boundaries (rolling 5-lap average). Fall back to `fuelUsePerHour` only when `> 5 L/hr` (engine actually under load).

## Overlay Details

**Cockpit-only rendering:** Every overlay hides itself when `t.connected && !t.isOnTrack` (driver is in the garage, get-in-car screen, replay, or spectator mode) — the BrowserWindow stays open but the React component returns null. The check is bypassed in edit mode so overlays can be positioned even when the user isn't actually driving. `t.isOnTrack` maps directly to the SDK's `IsOnTrack` irsdk_bool. The disconnect-state "Waiting for iRacing…" message still shows when `!t.connected` so the user knows the overlay is alive and the app is just waiting for the sim to start.

### Gauges (`/gauges`, 860×180)
RPM bar, throttle/brake input trace, gear indicator, speed, lap delta to best, fuel level, TC and ABS indicators. Each element independently configurable per session type.

TC/ABS are rendered via the `AidBlock` component which accepts a single `activeColor` hex string and derives rgba tints at render time (border at 0.75 opacity, background at 0.10 opacity). TC uses amber (`#fbbf24`), ABS uses purple (`#a78bfa`). Both auto-hide when `config.global.hideUnsupportedElements` is true and the car lacks the corresponding capability.

### Relative (`/relative`, 460×520)
Shows cars within ±5 positions of player sorted by computed gap (not `f2Time` — see SDK Notes). 9-column grid:
`34px 28px 30px 1fr 48px 44px 54px 62px 48px`
Columns: Position | Pos-Δ | Car# | Name | iRating | Safety Rating | Est. iR Δ | Gap | Closing Rate

Gap is shown to tenths of a second (e.g. `+1.3`). Lapped cars show `+N Lap` / `-N Lap`.

**Closing Rate column** shows how fast each car is closing on / pulling away from the player in seconds-per-lap. Positive value (green/red depending on direction) = closing, negative = separating. Computed via least-squares linear regression over an 8-second rolling window of gap history per car (`gapHistoryRef`, updated in a `useEffect` once per telemetry tick). Cells stay blank when fewer than 3 samples are recorded, the time span is <1s, or the magnitude is below the 0.05 s/lap noise floor. History is cleared per car on a sudden gap jump >20s (lapping, off-track→on-track transition, session reset) and dropped entirely when a car leaves the on-track set.

Color convention: green = good-for-player (catching a car ahead OR pulling away from a car behind), red = bad-for-player. The sign convention is unified across rows — positive always means closing — and the color disambiguates whether closing is good or bad for the player.

**Pit mode** kicks in when the player car is `inPit` (surface `1`=InPitStall or `2`=AproachingPits). The player's `LapDistPct` reflects pit-lane position rather than racing-line position, so the gap math becomes meaningless. While in pit:
- The list is sorted by `car.position` (classified leaderboard rank) instead of by computed gap; unclassified cars (`position === 0`) sort to the end so they can't displace the player from the visible window.
- The player remains in the visible set even though `!onTrack`, so they stay the slicing anchor.
- The Gap column renders `—` (dim gray) and the Closing Rate column is forcibly hidden — both are mathematically nonsense against the pit-lane reference.
- Gap history is cleared on entry to pit (in the `useEffect`) so the regression doesn't poison itself with parked-player samples after rejoining.
- A `PIT` badge appears in the overlay header next to the session badge.

Safety Rating is rendered by the `SafetyBadge` component as a letter + symbol badge, color-coded by sub-rating value:
- `≤ 2.0` → red (`#f87171`) + `!`
- `≤ 3.0` → amber (`#fbbf24`) + `▲`
- `≤ 4.0` → green (`#4ade80`) + `★`
- `> 4.0` → blue (`#38bdf8`) + `✦`

Est. iR Δ uses an Elo-style formula:
```
expectedPos = 1 + Σ P(opponent beats car)  where P = 1/(1 + 10^((myIR - opponentIR)/1000))
iRΔ ≈ round((expectedPos - actualPos) × (200 / N))
```
Only meaningful in official race sessions; always computed but shown/hidden via config.

### Pit Strategy (`/pit-strategy`, 360×420)
Three sections (each independently toggled via config):
- **Fuel** — current level, per-lap consumption (measured at lap boundaries), laps remaining
- **Tire Deg** — stint-scoped pace trend: stint best + last lap, headline trend (last vs avg of up-to-3 prior stint laps), secondary stint-best delta
- **Pit Window** — estimated last lap to pit based on current fuel

**Tire Deg logic (stint-scoped):** A "stint" is the contiguous run of clean flying laps since the most recent pit-affected lap. Computed by walking back from the end of `lapHistory` until a `pitAffected` lap is hit — everything after that is the current stint. Two numbers are derived:

1. **Headline trend** = `lastLap.time − avg(prior up-to-3 stint laps)`. Directional ("am I getting faster or slower?"). Null on s1; muted styling until the window has 3 prior samples (s4+). Color thresholds: green ≤ −0.05s (improving), neutral grey −0.05 to +0.05s, amber to +0.30s, red > +0.30s. A bad lap in the prior window inflates the baseline so the next lap reads artificially fast — known behaviour, self-corrects as the outlier rolls out.
2. **Stint-best delta** = `lastLap.time − stintBest.time`. Always ≥ 0. Smaller / secondary in the UI. "How off-peak am I right now?" Color: grey ≤ 0.1s, amber ≤ 0.5s, red > 0.5s.

Session-best is *not* referenced here — a fresh-tire run from an earlier stint tells you nothing about the current set. All laps kept in `lapHistoryRef` (max 30); deltas computed at render time, never stored.

**Pit-affected lap filtering:** Each `LapRecord` carries a `pitAffected: boolean` flag indicating whether the player was on pit road at any point during that lap (out-lap, in-lap, or a full pit stop mid-lap). A sticky `wasInPitThisLapRef` is OR'd with the player's per-tick `inPit` state and committed into the record at lap completion, then reset for the new lap. It's initialized to `true` at session start (every session begins with the player in the pit stall, so lap 1 is always an out-lap). The pit-affected flag both **filters laps from the stint** (a pit-affected lap is the stint boundary) and **resets the stint** — completing an in-lap/pit-lap immediately starts a fresh stint on the next clean lap.

### Tire Temps (`/tire-temps`, 220×145)
4-corner colored blocks (inner/mid/outer). Color scale: `#1e293b` (cold/no data) → blue → green → yellow → red (hot). Header reads "PIT TYRE TEMPS" with a small italic subheader `"updates slowly — refreshes most at pit stops"` (always-visible rather than a hover tooltip; overlays are click-through via `setIgnoreMouseEvents` so native tooltips don't fire reliably). The phrasing reflects the SDK reality: iRacing only exposes carcass temps, which change slowly while driving and are most visible during pit stops. No auto-hide — every car exposes carcass temps so the overlay is always meaningful when enabled.

### Radar (`/radar`, disabled)
Code exists in `src/renderer/src/overlays/Radar/`. Disabled because `CarIdxF2Time` data isn't granular enough for a useful proximity display in practice. Window is commented out in `OVERLAYS` array in `index.ts`. Re-enable when better positional data is available.

## Settings Window (680×560)

Sidebar-tabbed layout. The window is a fixed `<aside>` sidebar with six nav entries on the left, and a single scrollable pane on the right. State is just `useState<PaneId>('general')` in `Settings/index.tsx`; per-pane components live under `Settings/panes/`.

Six panes:
1. **General** (`panes/GeneralPane.tsx`) — launch-on-startup toggle, global `Auto-hide unsupported overlays` toggle, Overlay Positions reset (with layout-mode hint).
2. **Overlays** (`panes/OverlaysPane.tsx`) — the per-session-type matrix grouped by overlay, with a **sticky `<thead>`** (Practice / Qualifying / Race column labels stay visible while scrolling), group headers with short overlay descriptions, and **native `title` tooltips** on every row pulling copy from `panes/../lib.ts` (`OVERLAY_DESCRIPTIONS` / `ELEMENT_DESCRIPTIONS`).
3. **Shortcuts** (`panes/ShortcutsPane.tsx`) — live-record new shortcuts (modifier-key combos only); the recorder helpers `keyEventToAccelerator` / `formatAccelerator` live in `Settings/lib.ts`.
4. **Preview Mode** (`panes/PreviewModePane.tsx`) — enable/disable, pick simulated session type (practice/qualifying/race).
5. **Updates** (`panes/UpdatesPane.tsx`) — current version badge + update lifecycle (check → download → restart & install); powered by `electron-updater`.
6. **About** (`panes/AboutPane.tsx`) — version, external links to repo / changelog / new-issue / license. Links route through the `app:openExternal` IPC so they open in the user's default browser instead of hijacking the Settings window. Main-process side validates the URL is http(s) before calling `shell.openExternal`.

IPC channels for startup: `startup:get` (returns `boolean`) and `startup:set` (accepts `boolean`). Both call Electron's `app.getLoginItemSettings()` / `app.setLoginItemSettings()` which writes the Windows login item registry key — no additional libraries needed.

### In-App Updater (`src/main/updater.ts`)
Uses `electron-updater` (reads `publish` config from `package.json` — GitHub provider). `autoDownload: false` so the user explicitly triggers the download. `autoInstallOnAppQuit: true` so a downloaded update installs cleanly on normal exit even if the user doesn't click "Restart & Install".

**Update state machine:** `idle → checking → available | not-available | error`, then `available → downloading → ready → (restart & install)`.

IPC channels: `update:getStatus`, `update:check`, `update:download`, `update:install`, `app:version`.
The main process broadcasts `update:status` events to all windows so the Settings UI stays in sync.

**Important for releases:** GitHub releases must include the `latest.yml` file that electron-builder generates in `dist/`. This is the manifest `electron-updater` uses to find and verify the download. Upload it alongside the `.exe` files.

Default shortcuts:
- Layout Mode (toggle drag): `Ctrl+Shift+L`
- Open Settings: `Ctrl+Shift+O`

### Logging (`src/main/logging.ts`)

`electron-log` is the single sink for everything in the main process. `initLogging()` runs once at app-ready and:

1. Calls `electronLog.initialize()` — sets up renderer-side IPC so renderers can `import log from 'electron-log/renderer'`.
2. Calls `Object.assign(console, electronLog.functions)` — globally redirects `console.log / .info / .warn / .error / .debug` in the main process through electron-log's transports. **Plain `console.log(...)` in any main-process file lands in `main.log` automatically** — no need to import the scoped logger unless you want a scope tag in the line (see below).
3. Detects the build tier (`dev` / `prerelease` / `stable` via `app.isPackaged` + the version's `-` prerelease marker) and applies the matching default level: `debug` / `info` / `warn`.
4. Loads any persisted user override from `<userData>/log-level.json` and applies that instead.

Log file location: `<userData>/logs/main.log` — opened from the Settings → Perf HUD pane, or the About pane's "Open log folder" button.

**Conventions for main-process modules:**
- `console.log('[scope] message')` — fine for ad-hoc diagnostics. The bracketed prefix doubles as the scope label.
- `const log = electronLog.scope('scope-name'); log.info(...)` — preferred for modules that log frequently (the scope tag is structured rather than embedded in the message, and the scope can be filtered at runtime). `updater.ts` uses this pattern.
- **Don't** call `console.log` before `initLogging()` has run — those lines pre-date the redirect and only print to the dev terminal. The bootstrap in `index.ts` calls `initLogging()` early enough that this is rarely an issue in practice.

#73 pre-fix: `console.*` calls didn't reach `main.log` because `electronLog.initialize()` only sets up the renderer-side IPC, not the main-process console hijack. The `Object.assign` line above fixes that — added so the `[irsdk-cockpit-debug]` (#65) and `[irsdk-tire-debug]` (#71) diagnostic lines could actually be inspected post-mortem from packaged builds.

## Packaging

`electron-builder.json5` targets NSIS installer + portable `.exe`. Both in `dist/`.

**Important `asarUnpack` entries:**
- `resources/**` — PNG icons accessed at runtime via `app.getAppPath()`
- `**/node_modules/koffi/**` — native FFI bindings can't be inside `.asar`

Icon files live in `resources/` (generated by `scripts/generate-icons.mjs` using a canvas-based renderer). `buildResources/` (electron-builder default) is not used — icon path is explicitly configured.

## Known Gotchas

- **Bash tool can't `cd` into Windows paths** — use PowerShell (`Set-Location`) or pass absolute paths to git commands directly
- **`enableLargerThanScreen: true`** is set on all overlay windows to bypass Windows shell constraint that clamps windows to the work area
- **`koffi` must be in `asarUnpack`** or the FFI calls will fail in production builds
- **Radar overlay** is intentionally excluded from the `OVERLAYS` array in `main/index.ts` and from the Settings config table — its window definition is commented out with an explanatory note
- **`computeIRChanges`** returns an empty Map (not zeros) when fewer than 2 rated cars exist — callers should use `?? null` when reading from it
- **`CarIdxF2Time` is unreliable in practice** — returns 0 for any car that hasn't set a lap time yet. Use the `lapDistPct`-based `computeRelativeGap()` function instead (see SDK Notes)
- **AI driver filter** — do not filter on `CarIsAI` when building the driver list. AI cars have valid names and telemetry. Only filter `CarIsPaceCar`
- **`carCapabilities` is module-level state** in `iracingSdk.ts` — reset to all-false in `closeMemory()`
- **No live surface tire temps from iRacing** — only carcass (`*tempCL/CM/CR`) is exposed via the SDK. See SDK Notes for the full story; don't try to read `*tempL/M/R` (won't exist) or hide the overlay behind a "surface tire temps" capability flag
- **`mergeWithDefaults` must be kept in sync** — every new field added to `OverlayConfig` or any nested interface needs a corresponding merge branch, otherwise stored configs from older builds will silently drop the new field's default
