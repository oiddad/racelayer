import { describe, it, expect } from 'vitest'
import {
  type RadarEntry,
  assignLanes,
  PROXIMITY_WINDOW_SEC,
} from '../src/renderer/src/overlays/Radar/lib'
import type { CarTelemetry } from '../src/renderer/src/types/telemetry'

// Minimal car stub — assignLanes only reads carIdx.
const carStub = (carIdx: number): CarTelemetry =>
  ({ carIdx } as unknown as CarTelemetry)

const entry = (carIdx: number, gap: number): RadarEntry => ({
  car: carStub(carIdx),
  gap,
})

describe('assignLanes', () => {
  it('returns all centre when CarLeftRight reports neither', () => {
    const entries = [entry(2, -0.6), entry(4, -0.1), entry(7, 0.4)]
    const lanes = assignLanes(entries, false, false)
    expect(lanes.get(2)).toBe('centre')
    expect(lanes.get(4)).toBe('centre')
    expect(lanes.get(7)).toBe('centre')
  })

  it('returns empty map when no entries', () => {
    expect(assignLanes([], true, true).size).toBe(0)
  })

  describe('bug #67 — closest car wins the lane', () => {
    it('picks the car with smallest |gap|, not the most-ahead car', () => {
      // The screenshot scenario: #4 is 0.1s ahead (visually adjacent),
      // #2 is 0.6s ahead. CarLeftRight says left-only. Prior code put
      // #2 in the left lane because the signed-gap sort put it first.
      const entries = [entry(2, -0.6), entry(4, -0.1)]
      const lanes = assignLanes(entries, /*hasLeft*/ true, /*hasRight*/ false)
      expect(lanes.get(4)).toBe('left')
      expect(lanes.get(2)).toBe('centre')
    })

    it('works the same when the cars are sorted in either order', () => {
      const a = assignLanes([entry(2, -0.6), entry(4, -0.1)], true, false)
      const b = assignLanes([entry(4, -0.1), entry(2, -0.6)], true, false)
      expect(a.get(4)).toBe('left')
      expect(b.get(4)).toBe('left')
      expect(a.get(2)).toBe('centre')
      expect(b.get(2)).toBe('centre')
    })

    it('picks the closest car when both are behind', () => {
      const entries = [entry(2, +0.6), entry(4, +0.1)]
      const lanes = assignLanes(entries, false, true)
      expect(lanes.get(4)).toBe('right')
      expect(lanes.get(2)).toBe('centre')
    })

    it('picks the closest car when one is ahead and one is behind', () => {
      const entries = [entry(2, -0.4), entry(4, +0.1)]
      const lanes = assignLanes(entries, true, false)
      expect(lanes.get(4)).toBe('left') // closest by |gap|
      expect(lanes.get(2)).toBe('centre')
    })
  })

  describe('CarLeftRight == BOTH', () => {
    it('puts the two closest cars on opposite sides', () => {
      const entries = [
        entry(2, -0.6),
        entry(4, -0.1),
        entry(7, +0.5),
        entry(9, +0.05),
      ]
      const lanes = assignLanes(entries, true, true)
      // Closest two by |gap|: #9 (0.05) and #4 (0.1)
      expect(lanes.get(9)).toBe('left')
      expect(lanes.get(4)).toBe('right')
      expect(lanes.get(2)).toBe('centre')
      expect(lanes.get(7)).toBe('centre')
    })

    it('handles only one close car gracefully', () => {
      const entries = [entry(2, -0.1)]
      const lanes = assignLanes(entries, true, true)
      expect(lanes.get(2)).toBe('left')
    })
  })

  describe('proximity window', () => {
    it(`only considers cars within ±${PROXIMITY_WINDOW_SEC}s for side lanes`, () => {
      // Closest car is 2.5s ahead — outside the proximity window. With
      // hasLeft=true, no car qualifies for a side lane.
      const entries = [entry(2, -2.5), entry(4, -3.0)]
      const lanes = assignLanes(entries, true, false)
      expect(lanes.get(2)).toBe('centre')
      expect(lanes.get(4)).toBe('centre')
    })

    it('skips out-of-window cars even when an in-window car exists', () => {
      // #4 at -0.5 is in window, #2 at -2.5 is not. With hasLeft=true,
      // #4 wins the left lane regardless of signed-gap order.
      const entries = [entry(2, -2.5), entry(4, -0.5)]
      const lanes = assignLanes(entries, true, false)
      expect(lanes.get(4)).toBe('left')
      expect(lanes.get(2)).toBe('centre')
    })
  })

  it('does not mutate the input entries array', () => {
    const entries = [entry(2, -0.6), entry(4, -0.1)]
    const originalOrder = entries.map((e) => e.car.carIdx)
    assignLanes(entries, true, true)
    expect(entries.map((e) => e.car.carIdx)).toEqual(originalOrder)
  })
})
