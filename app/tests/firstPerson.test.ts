import { describe, expect, it } from 'vitest';
import {
  EYE_HEIGHT,
  SPRINT_FACTOR,
  WALK_SPEED,
  azimuthFromYaw,
  clampToBounds,
  eyeY,
  moveDelta,
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

describe('eyeY', () => {
  it('stands 1.7 m above ground, scaled by exaggeration (contract §0)', () => {
    expect(eyeY(50, 1)).toBeCloseTo(51.7);
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
