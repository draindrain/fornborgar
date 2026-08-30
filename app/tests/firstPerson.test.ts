import { describe, expect, it } from 'vitest';
import {
  EYE_HEIGHT,
  LOOK_RATE_PITCH,
  LOOK_RATE_YAW,
  SPRINT_FACTOR,
  WALK_SPEED,
  axesFromKeys,
  azimuthFromYaw,
  clampToBounds,
  eyeY,
  lookRateDelta,
  mergeMoveAxes,
  moveDelta,
  moveDeltaAxes,
  yawFromAzimuth,
  type MoveKeys,
} from '../src/camera/firstPerson';

const keys = (partial: Partial<MoveKeys>): MoveKeys => ({
  forward: false,
  back: false,
  left: false,
  right: false,
  sprint: false,
  ...partial,
});

describe('azimuth <-> yaw', () => {
  it('north is -z, east is +x (contract §0)', () => {
    // Looking direction for yaw θ is (−sin θ, −cos θ) on the ground plane.
    const north = yawFromAzimuth(0);
    expect(-Math.sin(north)).toBeCloseTo(0);
    expect(-Math.cos(north)).toBeCloseTo(-1); // toward −z = north
    const east = yawFromAzimuth(90);
    expect(-Math.sin(east)).toBeCloseTo(1); // toward +x = east
    expect(-Math.cos(east)).toBeCloseTo(0);
  });

  it('round-trips', () => {
    for (const az of [0, 45, 90, 135, 180, 225, 270, 315]) {
      expect(azimuthFromYaw(yawFromAzimuth(az))).toBeCloseTo(az);
    }
  });
});

describe('moveDelta', () => {
  it('walks forward along the heading at walk speed', () => {
    // Facing east: forward one second should move +x by WALK_SPEED.
    const { dx, dz } = moveDelta(yawFromAzimuth(90), keys({ forward: true }), 1);
    expect(dx).toBeCloseTo(WALK_SPEED);
    expect(dz).toBeCloseTo(0);
  });

  it('strafes perpendicular to the heading', () => {
    // Facing north (−z), strafing right goes east (+x).
    const { dx, dz } = moveDelta(yawFromAzimuth(0), keys({ right: true }), 1);
    expect(dx).toBeCloseTo(WALK_SPEED);
    expect(dz).toBeCloseTo(0);
  });

  it('normalizes diagonals and applies sprint', () => {
    const diag = moveDelta(yawFromAzimuth(0), keys({ forward: true, right: true }), 1);
    expect(Math.hypot(diag.dx, diag.dz)).toBeCloseTo(WALK_SPEED);
    const sprint = moveDelta(yawFromAzimuth(0), keys({ forward: true, sprint: true }), 0.5);
    expect(Math.hypot(sprint.dx, sprint.dz)).toBeCloseTo(WALK_SPEED * SPRINT_FACTOR * 0.5);
  });

  it('is zero with no keys or with opposing keys', () => {
    expect(moveDelta(1.23, keys({}), 1)).toEqual({ dx: 0, dz: 0 });
    expect(moveDelta(1.23, keys({ forward: true, back: true }), 1)).toEqual({ dx: 0, dz: 0 });
  });
});

describe('mergeMoveAxes', () => {
  it('is exactly the keyboard axes with no stick', () => {
    for (const k of [keys({}), keys({ forward: true }), keys({ back: true, left: true })]) {
      expect(mergeMoveAxes(k, null)).toEqual(axesFromKeys(k));
    }
  });

  it('reads stick +y as forward, i.e. -z', () => {
    expect(mergeMoveAxes(keys({}), { x: 0, y: 1 })).toEqual({ x: 0, z: -1 });
    expect(mergeMoveAxes(keys({}), { x: 1, y: 0 })).toEqual({ x: 1, z: 0 });
  });

  it('keeps partial deflection partial — a stick half over is a slower walk', () => {
    const half = mergeMoveAxes(keys({}), { x: 0, y: 0.5 });
    expect(Math.hypot(half.x, half.z)).toBeCloseTo(0.5);
  });

  it('clamps keys plus stick back to unit length', () => {
    const both = mergeMoveAxes(keys({ forward: true }), { x: 0, y: 1 });
    expect(Math.hypot(both.x, both.z)).toBeCloseTo(1);
    expect(both.z).toBeCloseTo(-1); // still forward, not double speed
    const diag = mergeMoveAxes(keys({ right: true }), { x: 0, y: 1 });
    expect(Math.hypot(diag.x, diag.z)).toBeCloseTo(1);
  });
});

describe('moveDeltaAxes', () => {
  it('walks along the heading at the given speed', () => {
    // Facing east, full forward axis (−z) for one second.
    const { dx, dz } = moveDeltaAxes(yawFromAzimuth(90), 0, -1, 1);
    expect(dx).toBeCloseTo(WALK_SPEED);
    expect(dz).toBeCloseTo(0);
  });

  it('scales with the axis magnitude', () => {
    const half = moveDeltaAxes(yawFromAzimuth(0), 0, -0.5, 1);
    expect(Math.hypot(half.dx, half.dz)).toBeCloseTo(WALK_SPEED * 0.5);
  });

  it('is zero at rest', () => {
    expect(moveDeltaAxes(1.23, 0, 0, 1)).toEqual({ dx: 0, dz: 0 });
  });

  it('still produces moveDelta’s Phase-2 numbers through the wrapper', () => {
    // The keyboard path now goes through the analog one; these are the values
    // the original hand-rolled implementation returned.
    const yaw = 0.7;
    const fwd = moveDelta(yaw, keys({ forward: true }), 0.25);
    expect(fwd.dx).toBeCloseTo(-Math.sin(yaw) * WALK_SPEED * 0.25);
    expect(fwd.dz).toBeCloseTo(-Math.cos(yaw) * WALK_SPEED * 0.25);
    const strafe = moveDelta(yaw, keys({ right: true, sprint: true }), 0.25);
    const s = WALK_SPEED * SPRINT_FACTOR * 0.25;
    expect(strafe.dx).toBeCloseTo(Math.cos(yaw) * s);
    expect(strafe.dz).toBeCloseTo(-Math.sin(yaw) * s);
  });
});

describe('lookRateDelta', () => {
  it('turns right for stick right, matching the mouse’s sign', () => {
    const { dYaw } = lookRateDelta({ x: 1, y: 0 }, 0.5);
    expect(dYaw).toBeCloseTo(-LOOK_RATE_YAW * 0.5);
  });

  it('raises the pitch for stick up', () => {
    const { dPitch } = lookRateDelta({ x: 0, y: 1 }, 0.5);
    expect(dPitch).toBeCloseTo(LOOK_RATE_PITCH * 0.5);
  });

  it('uses a sign-preserving square curve, so small nudges aim', () => {
    const { dYaw, dPitch } = lookRateDelta({ x: -0.5, y: -0.5 }, 1);
    expect(dYaw).toBeCloseTo(0.25 * LOOK_RATE_YAW);
    expect(dPitch).toBeCloseTo(-0.25 * LOOK_RATE_PITCH);
  });

  it('is zero at rest', () => {
    const { dYaw, dPitch } = lookRateDelta({ x: 0, y: 0 }, 1);
    expect(dYaw).toBeCloseTo(0);
    expect(dPitch).toBeCloseTo(0);
  });
});

describe('eyeY', () => {
  it('stands 2 m above ground, scaled by exaggeration (contract §0)', () => {
    expect(eyeY(50, 1)).toBeCloseTo(52);
    // The whole terrain group is Y-scaled, so the eye scales with it.
    expect(eyeY(50, 1.5)).toBeCloseTo((50 + EYE_HEIGHT) * 1.5);
  });
});

describe('clampToBounds', () => {
  const bounds = { minX: -2000, minZ: -2000, maxX: 2000, maxZ: 2000 };
  it('passes interior points through and clamps the edge with a margin', () => {
    expect(clampToBounds(12, -34, bounds)).toEqual({ x: 12, z: -34 });
    expect(clampToBounds(-9999, 9999, bounds)).toEqual({ x: -1990, z: 1990 });
  });
});
