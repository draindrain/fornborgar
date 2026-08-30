/**
 * The virtual thumbstick's geometry (ui/joystick.ts).
 *
 * The widget itself needs a browser; what is worth pinning without one is the
 * mapping from a finger's pixel offset to a stick value, because every way it
 * can be wrong is a control that feels broken rather than one that looks it:
 * an inverted axis walks backwards, a missing deadzone drifts while the thumb
 * rests, and a hard deadzone cut makes the stick jump on wake-up.
 */

import { describe, expect, it } from 'vitest';
import { stickVector } from '../src/ui/joystick';

const R = 64;

describe('stickVector', () => {
  it('is zero at the centre and anywhere inside the deadzone', () => {
    expect(stickVector(0, 0, R)).toEqual({ x: 0, y: 0 });
    expect(stickVector(R * 0.1, 0, R)).toEqual({ x: 0, y: 0 });
    expect(stickVector(0, -R * 0.14, R)).toEqual({ x: 0, y: 0 });
  });

  it('leaves the deadzone continuously — no jump to 0.15', () => {
    const justOut = stickVector(R * 0.1501, 0, R);
    expect(justOut.x).toBeGreaterThan(0);
    expect(justOut.x).toBeLessThan(0.01);
  });

  it('reaches exactly 1 at the rim and saturates beyond it', () => {
    expect(stickVector(R, 0, R).x).toBeCloseTo(1);
    const far = stickVector(R * 5, 0, R);
    expect(far.x).toBeCloseTo(1);
    expect(Math.hypot(far.x, far.y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('flips screen y: dragging down is backwards', () => {
    expect(stickVector(0, R, R).y).toBeCloseTo(-1);
    expect(stickVector(0, -R, R).y).toBeCloseTo(1);
  });

  it('preserves the direction of a diagonal drag', () => {
    // Down-right at 45°: equal magnitudes, +x and −y.
    const v = stickVector(R, R, R);
    expect(v.x).toBeCloseTo(-v.y);
    expect(v.x).toBeGreaterThan(0);
    expect(Math.hypot(v.x, v.y)).toBeCloseTo(1);
    // The angle survives the deadzone rescale too.
    const near = stickVector(30, 60, R);
    expect(near.x / -near.y).toBeCloseTo(0.5);
  });

  it('is zero for a stick with no measured size', () => {
    expect(stickVector(10, 10, 0)).toEqual({ x: 0, y: 0 });
  });
});
