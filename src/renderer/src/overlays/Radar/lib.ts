import type { CarTelemetry } from '../../types/telemetry'

// Radar overlay — pure logic.
// React-free and side-effect-free so the lane-assignment math can be
// unit-tested directly from `tests/`.

/** An opponent close enough to the player to be drawn on the radar.
 *  `gap` follows the Relative-overlay convention: seconds relative to the
 *  player, negative = car is ahead of the player, positive = car is behind. */
export interface RadarEntry {
  car: CarTelemetry
  gap: number
}

export type RadarLane = 'left' | 'centre' | 'right'

/** Window (seconds) within which a car is "in proximity" — close enough to
 *  potentially deserve a side lane based on the iRacing `CarLeftRight` signal.
 *  Cars further out always land in the centre lane. */
export const PROXIMITY_WINDOW_SEC = 2

/**
 * Decide which lane each radar entry should sit in.
 *
 *   1. Cars further than `PROXIMITY_WINDOW_SEC` from the player → centre.
 *   2. For close cars: the iRacing `CarLeftRight` signal tells us a car is
 *      to the player's left, right, or both — but NOT which carIdx that is.
 *      We pick the lane assignment by **smallest `|gap|`**: whichever car
 *      is physically nearest the player is the one generating the
 *      proximity signal.
 *
 * Bug #67: prior code sorted close cars by signed gap (`a.gap - b.gap`,
 * most-negative-first = furthest-ahead-first) and assigned lanes by sort
 * index. When two cars were close ahead of the player — say #2 at −0.6s and
 * #4 at −0.1s — the sort put #2 first, so #2 got the left lane and the
 * actually-adjacent #4 fell through to centre. Sorting by `|gap|` instead
 * fixes the multi-car proximity case.
 *
 * Underdetermined case: when `CarLeftRight` is "both" and we have 2+ cars in
 * proximity, the signal doesn't tell us which is left vs right. We pick
 * deterministically: closest car → left lane, next-closest → right lane.
 * This is no worse than the old behaviour and is consistent across ticks.
 *
 * @param entries  All opponent cars within the radar's overall window
 * @param hasLeft  Derived from `CarLeftRight`: a car is to the player's left
 * @param hasRight Derived from `CarLeftRight`: a car is to the player's right
 * @returns        Map of `carIdx` → assigned lane
 */
export function assignLanes(
  entries: readonly RadarEntry[],
  hasLeft: boolean,
  hasRight: boolean,
): Map<number, RadarLane> {
  const lanes = new Map<number, RadarLane>()

  // Default everything to centre; the loop below overrides for the 1-2
  // cars that win a side lane.
  for (const e of entries) lanes.set(e.car.carIdx, 'centre')

  if (!hasLeft && !hasRight) return lanes

  // Sort close cars by *absolute* gap so the physically-nearest car wins
  // the side lane, not whichever car is furthest along the signed-gap sort.
  const close = entries
    .filter((e) => Math.abs(e.gap) < PROXIMITY_WINDOW_SEC)
    .slice()
    .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap))

  if (close.length === 0) return lanes

  if (hasLeft && hasRight) {
    lanes.set(close[0].car.carIdx, 'left')
    if (close.length > 1) lanes.set(close[1].car.carIdx, 'right')
    return lanes
  }

  if (hasLeft) {
    lanes.set(close[0].car.carIdx, 'left')
    return lanes
  }

  // hasRight && !hasLeft
  lanes.set(close[0].car.carIdx, 'right')
  return lanes
}
