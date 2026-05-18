import { useTelemetry } from '../../contexts/TelemetryContext'
import { useEditMode } from '../../hooks/useEditMode'
import { useDrag } from '../../hooks/useDrag'
import { useOverlayConfig } from '../../contexts/OverlayConfigContext'
import type { TireCorner } from '../../types/telemetry'
import styles from './TireTemps.module.css'

// ── Temperature colour coding ─────────────────────────────────────────────────

/** Map a tyre temperature (°C) to a display colour.
 *  Thresholds tuned for GT3-class tyres (~75–100 °C optimal window). */
function tempColor(c: number): string {
  if (c <= 0)   return '#1e293b'   // no data — dim slate (bar visible but clearly empty)
  if (c < 40)   return '#3b82f6'   // stone cold — deep blue
  if (c < 55)   return '#60a5fa'   // cold — light blue
  if (c < 70)   return '#34d399'   // coming up — teal-green
  if (c < 85)   return '#4ade80'   // optimal — green
  if (c < 95)   return '#a3e635'   // warm — yellow-green
  if (c < 105)  return '#fbbf24'   // getting hot — amber
  if (c < 115)  return '#f97316'   // hot — orange
  return '#ef4444'                  // overheating — red
}

function tempLabel(c: number): string {
  if (c <= 0) return '—'
  return `${Math.round(c)}°`
}

function avgTemp(t: TireCorner): number {
  return (t[0] + t[1] + t[2]) / 3
}

// ── Tyre corner cell ──────────────────────────────────────────────────────────

function TyreCell({ label, temps, flip }: {
  label: string
  temps: TireCorner
  /** true for right-side tyres — reverses inner/outer so outer is always track-side */
  flip?: boolean
}) {
  const [a, b, c] = flip ? [temps[2], temps[1], temps[0]] : temps
  const avg = avgTemp(temps)

  return (
    <div className={styles.tyreCell}>
      <div className={styles.tyreName}>{label}</div>
      <div className={styles.tyreBars}>
        <div className={styles.tyreBar} style={{ background: tempColor(a) }} title={tempLabel(a)} />
        <div className={styles.tyreBar} style={{ background: tempColor(b) }} title={tempLabel(b)} />
        <div className={styles.tyreBar} style={{ background: tempColor(c) }} title={tempLabel(c)} />
      </div>
      <div className={styles.tyreAvg} style={{ color: tempColor(avg) }}>
        {tempLabel(avg)}
      </div>
    </div>
  )
}

// ── Main overlay ──────────────────────────────────────────────────────────────

export default function TireTemps() {
  const t = useTelemetry()
  const editMode = useEditMode()
  const { onMouseDown, dragging } = useDrag(editMode)
  const { config } = useOverlayConfig()

  const sType = t.sessionType === 'unknown' ? 'practice' : t.sessionType

  // Always show when the user has the overlay enabled. iRacing only exposes
  // internal tire carcass temps via the SDK — see iracingSdk.ts and #69 — so
  // the values change slowly and become noticeable mostly during pit stops.
  // The header reads "PIT TYRE TEMPS" so that's clear to the driver; there's
  // no live-temp variant to hide behind a capability flag.
  if (!config.tireTemps.enabled[sType] && !editMode) return null

  // Hide entirely when the driver is in an iRacing menu (garage / get-in-car /
  // replay / spectator). Edit mode bypasses this so overlays can be positioned.
  if (t.connected && !t.isOnTrack && !editMode) return null

  const containerClass = [
    styles.container,
    editMode ? styles.editMode : '',
  ].join(' ')

  if (!t.connected) {
    return (
      <div
        className={containerClass}
        onMouseDown={onMouseDown}
        style={{ cursor: editMode ? (dragging ? 'grabbing' : 'grab') : 'default' }}
      >
        {editMode && <div className={styles.editBanner}>✥ DRAG TO REPOSITION</div>}
        <span className={styles.disconnected}>Waiting for iRacing…</span>
      </div>
    )
  }

  return (
    <div
      className={containerClass}
      onMouseDown={onMouseDown}
      style={{ cursor: editMode ? (dragging ? 'grabbing' : 'grab') : 'default' }}
    >
      {editMode && <div className={styles.editBanner}>✥ DRAG TO REPOSITION</div>}
      <div className={styles.header}>PIT TYRE TEMPS</div>
      <div className={styles.subheader}>updates slowly — refreshes most at pit stops</div>
      <div className={styles.grid}>
        <TyreCell label="LF" temps={t.tireLF} />
        <TyreCell label="RF" temps={t.tireRF} flip />
        <TyreCell label="LR" temps={t.tireLR} />
        <TyreCell label="RR" temps={t.tireRR} flip />
      </div>
      <div className={styles.legend}>
        <span style={{ color: '#60a5fa' }}>COLD</span>
        <span style={{ color: '#4ade80' }}>OPTIMAL</span>
        <span style={{ color: '#f97316' }}>HOT</span>
      </div>
    </div>
  )
}
