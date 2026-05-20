import { useMemo, useRef, useEffect } from 'react'
import { useTelemetry } from '../../contexts/TelemetryContext'
import { useEditMode } from '../../hooks/useEditMode'
import { useDrag } from '../../hooks/useDrag'
import { useOverlayConfig } from '../../contexts/OverlayConfigContext'
import {
  type PitTrackerState,
  INITIAL_PIT_TRACKER_STATE,
  reducePitTracker,
  computeStintMetrics,
  computeFuelStats,
  formatLapTime,
  pitCountdownLabel,
} from './lib'
import styles from './PitStrategy.module.css'

export default function PitStrategy() {
  const t = useTelemetry()
  const { config } = useOverlayConfig()

  // ── Pit tracker state machine ────────────────────────────────────────────────
  // All the per-tick bookkeeping (lap history, fuel samples, pit-affected flag,
  // session-transition detection) lives in `reducePitTracker` so it can be
  // unit-tested directly.  This component just feeds it one tick per telemetry
  // update and reads the result.
  const stateRef = useRef<PitTrackerState>(INITIAL_PIT_TRACKER_STATE)

  useEffect(() => {
    const playerInPit = t.cars.find((c) => c.carIdx === t.playerCarIdx)?.inPit ?? false
    stateRef.current = reducePitTracker(stateRef.current, {
      connected: t.connected,
      sessionType: t.sessionType,
      lap: t.lap,
      lapLastLapTime: t.lapLastLapTime,
      fuelLevel: t.fuelLevel,
      playerInPit,
    })
  }, [
    t.connected,
    t.sessionType,
    t.lap,
    t.lapLastLapTime,
    t.fuelLevel,
    t.cars,
    t.playerCarIdx,
  ])

  // ── Derived stats ─────────────────────────────────────────────────────────────
  // All pure logic lives in `./lib` so it can be unit-tested.  This memo just
  // pipes the current state ref through those functions on each render.
  const stats = useMemo(() => {
    const fuel = computeFuelStats({
      samples: stateRef.current.fuelPerLapSamples,
      fuelLevel: t.fuelLevel,
      fuelUsePerHour: t.fuelUsePerHour,
      currentLap: t.lap,
      lapLastLapTime: t.lapLastLapTime,
      // New for #12 — drives race-endpoint awareness ("Finish on fuel" /
      // urgency colour ramp).  See `computeFuelStats` for the sentinel
      // handling when this is -1 / 32767 in timed races.
      sessionLapsRemain: t.sessionLapsRemain,
      // #70 follow-up: SessionState >= 5 (Checkered / CoolDown) is the
      // field-wide race-over signal that latches `finishOnFuel` true even
      // when iRacing reverts `sessionLapsRemain` to a stale positive
      // integer in cool-down.
      sessionState: t.sessionState,
    })
    const stint = computeStintMetrics(stateRef.current.lapHistory)
    return { ...fuel, ...stint }
  }, [t.fuelLevel, t.fuelUsePerHour, t.lap, t.lapLastLapTime, t.sessionLapsRemain, t.sessionState])

  const editMode = useEditMode()
  const { onMouseDown, dragging } = useDrag(editMode)

  const sType = t.sessionType === 'unknown' ? 'practice' : t.sessionType
  const sec = config.pitStrategy.sections
  const showFuel      = sec.fuel[sType]
  const showTireDeg   = sec.tireDeg[sType]
  const showPitWindow = sec.pitWindow[sType]

  const containerProps = {
    className: `${styles.container} ${editMode ? styles.editMode : ''}`,
    onMouseDown,
    style: { cursor: editMode ? (dragging ? 'grabbing' : 'grab') : 'default' } as React.CSSProperties,
  }

  if (!config.pitStrategy.enabled[sType] && !editMode) return null

  // Hide entirely when the driver is in an iRacing menu (garage / get-in-car /
  // replay / spectator). Edit mode bypasses this so overlays can be positioned.
  if (t.connected && !t.isOnTrack && !editMode) return null

  if (!t.connected) {
    return (
      <div {...containerProps}>
        {editMode && <div className={styles.editBanner}>✥ DRAG TO REPOSITION</div>}
        <div className={styles.header}><span className={styles.label}>PIT STRATEGY</span></div>
        <div className={styles.muted}>Waiting for iRacing…</div>
      </div>
    )
  }

  return (
    <div {...containerProps}>
      {editMode && <div className={styles.editBanner}>✥ DRAG TO REPOSITION</div>}
      <div className={styles.header}>
        <span className={styles.label}>PIT STRATEGY</span>
        <span className={styles.lapInfo}>Lap {t.lap}</span>
      </div>

      {/* Fuel section */}
      {showFuel && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>FUEL</div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>Current</span>
            <span className={styles.statValue}>{t.fuelLevel.toFixed(1)} L</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>
              {stateRef.current.fuelPerLapSamples.length > 0 ? 'Per lap (avg)' : 'Per lap (est.)'}
            </span>
            <span className={styles.statValue}>
              {stats.hasReliableEstimate ? `${stats.fuelPerLap.toFixed(2)} L` : '--'}
            </span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>Laps remaining</span>
            <span
              className={styles.statValue}
              style={{ color: stats.lapsOnFuel < 3 ? '#f87171' : stats.lapsOnFuel < 6 ? '#fbbf24' : '#4ade80' }}
            >
              {stats.lapsOnFuel > 0 ? stats.lapsOnFuel.toFixed(1) : '--'}
            </span>
          </div>
        </div>
      )}

      {/* Tire degradation — stint-scoped pace trend */}
      {showTireDeg && stats.lastLap && stats.stintBest && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>TIRE DEG</span>
            <span className={styles.stintBadge}>
              Stint of {stats.currentStint.length}
            </span>
          </div>

          {/* Stint best lap */}
          <div className={styles.lapRow}>
            <span className={styles.lapNum}>L{stats.stintBest.lap}</span>
            <span className={styles.lapTime}>{formatLapTime(stats.stintBest.time)}</span>
            <span className={styles.bestBadge}>BEST</span>
          </div>

          {/* Last lap — only render if it isn't the stint best */}
          {stats.lastLap !== stats.stintBest && (
            <div className={styles.lapRow}>
              <span className={styles.lapNum}>L{stats.lastLap.lap}</span>
              <span className={styles.lapTime}>{formatLapTime(stats.lastLap.time)}</span>
              <span className={styles.lastBadge}>LAST</span>
            </div>
          )}

          {/* Headline trend: last lap vs prior up-to-3 in stint */}
          {stats.trendDelta !== null && stats.priorCount > 0 && (
            <div className={styles.degAvg}>
              <span className={styles.degAvgLabel}>
                vs LAST {stats.priorCount}
              </span>
              <span
                className={styles.degAvgValue}
                style={{
                  color: !stats.trendMature
                    ? '#64748b'
                    : stats.trendDelta <= -0.05 ? '#4ade80'
                    : stats.trendDelta <= 0.05 ? '#cbd5e1'
                    : stats.trendDelta <= 0.30 ? '#fbbf24'
                    : '#f87171',
                  opacity: stats.trendMature ? 1 : 0.55,
                }}
              >
                {stats.trendDelta > 0 ? '+' : ''}{stats.trendDelta.toFixed(3)}s
              </span>
            </div>
          )}

          {/* Stint-best delta (smaller, secondary) */}
          {stats.stintBestDelta !== null && stats.currentStint.length > 1 && (
            <div className={styles.stintBestRow}>
              <span className={styles.stintBestLabel}>vs STINT BEST</span>
              <span
                className={styles.stintBestValue}
                style={{
                  color: stats.stintBestDelta <= 0.1 ? '#94a3b8'
                       : stats.stintBestDelta <= 0.5 ? '#fbbf24'
                       : '#f87171'
                }}
              >
                +{stats.stintBestDelta.toFixed(3)}s
              </span>
            </div>
          )}
        </div>
      )}

      {/* Pit window — three render modes (issue #12):
            1. Finish-on-fuel:  race ends before fuel runs out → green tick
                                 + "(N laps left)" context.
            2. Fuel-forced pit: "Pit by Lap X" + "in N laps" with urgency
                                 colour ramp (safe → warn → danger).
            3. Unknown:          rendered as null — the section disappears
                                 entirely (same shape as before #12).
          See `computeFuelStats()` for the decision logic. */}
      {showPitWindow && stats.urgency === 'finish' && (
        <div className={`${styles.pitWindow} ${styles.pitWindowFinish}`}>
          <span className={styles.pitWindowIcon}>✓</span>
          <span className={styles.pitWindowLabel}>Finish on fuel</span>
          {stats.lapsLeftInRace !== null && (
            <span className={styles.pitWindowLapsLeft}>
              {stats.lapsLeftInRace} {stats.lapsLeftInRace === 1 ? 'lap' : 'laps'} left
            </span>
          )}
        </div>
      )}
      {showPitWindow && stats.pitLap !== null && stats.urgency !== 'finish' && (
        <div className={`${styles.pitWindow} ${urgencyClass(stats.urgency, styles)}`}>
          {/* Primary callout — big + coloured.  The countdown is what the
              driver actually needs to react to; phrasing special-cases the
              `Pit this lap` / `Pit next lap` boundary so the message is
              unambiguous mid-race (no "is 'in 1 lap' now or end-of-lap?"
              confusion).  Falls back to "Pit in N laps" at 2+. */}
          <span className={styles.pitWindowCountdown}>
            {pitCountdownLabel(stats.lapsUntilPit)}
          </span>
          {/* Secondary reference — the absolute lap, muted.  Useful when
              planning ("OK so by lap 14, that gives me one more chance to
              pass before the stop") but not the at-a-glance value. */}
          <span className={styles.pitWindowLap}>by Lap {stats.pitLap}</span>
        </div>
      )}
    </div>
  )
}

/** Map a `PitUrgency` tier to its CSS-module class.  Lifted out of the JSX
 *  so the table stays readable + adding tiers later is a one-line change. */
function urgencyClass(
  urgency: 'safe' | 'warn' | 'danger' | 'finish' | 'unknown',
  s: Record<string, string>,
): string {
  switch (urgency) {
    case 'safe':   return s.pitWindowSafe
    case 'warn':   return s.pitWindowWarn
    case 'danger': return s.pitWindowDanger
    default:       return ''
  }
}
