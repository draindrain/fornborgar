/**
 * The face of the moon, as a schematic.
 *
 * A blank disc is wrong in a way people notice immediately: the near side of
 * the moon is the same arrangement of dark maria every night of every year, and
 * has been for three billion years, so the Iron Age sky this app draws had
 * exactly the face we see. Leaving it off is not neutrality.
 *
 * What is *not* done here is invent one. There is no noise, no procedural
 * mottling and no photograph. Each feature below is a named mare or ray crater
 * at its catalogued selenographic centre, given the angular radius its
 * catalogued diameter implies on a 1737.4 km sphere. The renderer draws them as
 * soft-edged discs — so this is a **diagram of the moon's face, not an image of
 * it**, and the methods panel says exactly that. What it buys is that the moon
 * is recognisably the moon, and that the pattern is right way up and right way
 * round, which a texture applied without the axis would not be.
 *
 * Coordinates are IAU selenographic: longitude positive east, latitude positive
 * north, origin at the mean sub-Earth point. Diameters are the conventional
 * catalogued figures; the maria are irregular and a disc is an approximation of
 * an outline, which is the main reason this is called a schematic.
 *
 * Not modelled: libration, which rocks this whole pattern by up to about 7° in
 * each direction over a month and is what lets us see 59 % of the surface
 * rather than 50 %.
 */

/** Mean lunar radius, km — the same figure `lunar.ts` sizes the disc from. */
export const MOON_RADIUS_KM = 1737.4;

export interface LunarFeature {
  name: string;
  /** Selenographic longitude, degrees east. */
  lonDeg: number;
  /** Selenographic latitude, degrees north. */
  latDeg: number;
  /** Catalogued diameter, km. */
  diameterKm: number;
  /**
   * How much darker than the highlands, 0…1. The maria are basalt at about
   * 0.07 reflectance against 0.11 for the highlands — a ratio of roughly two
   * to three — and these are tuned to that contrast, not beyond it.
   */
  darkness: number;
}

/**
 * The maria, largest first. Oceanus Procellarum is not a basin at all but a
 * vast irregular plain, so its disc is the crudest approximation in the list;
 * Mare Frigoris is a long thin arc and its disc is deliberately shallow and
 * undersized rather than a slab across the northern limb.
 */
export const LUNAR_MARIA: readonly LunarFeature[] = [
  { name: 'Oceanus Procellarum', lonDeg: -55.0, latDeg: 20.0, diameterKm: 2300, darkness: 0.4 },
  { name: 'Mare Imbrium', lonDeg: -15.6, latDeg: 32.8, diameterKm: 1145, darkness: 0.5 },
  { name: 'Mare Frigoris', lonDeg: 1.4, latDeg: 56.0, diameterKm: 950, darkness: 0.26 },
  { name: 'Mare Fecunditatis', lonDeg: 51.3, latDeg: -7.8, diameterKm: 909, darkness: 0.44 },
  { name: 'Mare Tranquillitatis', lonDeg: 31.4, latDeg: 8.5, diameterKm: 873, darkness: 0.52 },
  { name: 'Mare Nubium', lonDeg: -16.6, latDeg: -21.3, diameterKm: 715, darkness: 0.38 },
  { name: 'Mare Serenitatis', lonDeg: 17.5, latDeg: 28.0, diameterKm: 707, darkness: 0.5 },
  { name: 'Mare Crisium', lonDeg: 59.1, latDeg: 17.0, diameterKm: 556, darkness: 0.52 },
  { name: 'Mare Insularum', lonDeg: -30.9, latDeg: 7.5, diameterKm: 513, darkness: 0.3 },
  { name: 'Mare Humorum', lonDeg: -38.6, latDeg: -24.4, diameterKm: 389, darkness: 0.44 },
  { name: 'Mare Cognitum', lonDeg: -23.1, latDeg: -10.0, diameterKm: 376, darkness: 0.34 },
  { name: 'Mare Smythii', lonDeg: 87.5, latDeg: 1.3, diameterKm: 373, darkness: 0.38 },
  { name: 'Mare Nectaris', lonDeg: 35.5, latDeg: -15.2, diameterKm: 333, darkness: 0.46 },
  { name: 'Mare Vaporum', lonDeg: 3.6, latDeg: 13.3, diameterKm: 245, darkness: 0.38 },
];

export interface LunarRayCrater {
  name: string;
  lonDeg: number;
  latDeg: number;
  /** Extent of the bright ray system, km — far larger than the crater itself. */
  raySpanKm: number;
  brightness: number;
}

/**
 * The ray craters. At full moon these, not the craters, are what the eye picks
 * out: Tycho's rays reach a third of the way round the disc and are the single
 * most conspicuous thing on it.
 */
export const LUNAR_RAY_CRATERS: readonly LunarRayCrater[] = [
  { name: 'Tycho', lonDeg: -11.2, latDeg: -43.3, raySpanKm: 1500, brightness: 0.16 },
  { name: 'Copernicus', lonDeg: -20.1, latDeg: 9.6, raySpanKm: 800, brightness: 0.1 },
  { name: 'Kepler', lonDeg: -38.0, latDeg: 8.1, raySpanKm: 500, brightness: 0.08 },
  { name: 'Aristarchus', lonDeg: -47.4, latDeg: 23.7, raySpanKm: 260, brightness: 0.14 },
];

/**
 * Unit vector in the moon's own frame: x toward the sub-Earth point (longitude
 * zero), y east, z north. The renderer reconstructs exactly this vector for
 * each pixel of the disc, so a dot product is the whole lookup.
 */
export function selenographicDirection(lonDeg: number, latDeg: number): [number, number, number] {
  const lon = lonDeg * (Math.PI / 180);
  const lat = latDeg * (Math.PI / 180);
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

/** Angular radius of a feature of this diameter, radians, at the moon's centre. */
export function featureAngularRadius(diameterKm: number): number {
  return diameterKm / 2 / MOON_RADIUS_KM;
}

const f = (n: number): string => n.toFixed(5);

/**
 * Emit the albedo lookup as GLSL.
 *
 * Generated rather than hand-written because the table above is the thing worth
 * reading, and because GLSL ES 1.00 — which is what a `ShaderMaterial` compiles
 * to — has no const array initialisers to put it in. One unrolled line per
 * feature; the whole function runs only for pixels inside a half-degree disc.
 */
export function lunarAlbedoGlsl(): string {
  const lines: string[] = [];
  lines.push('/** Reflectance of the lunar surface at a point, 0…1. Generated by');
  lines.push(' *  sky/lunarFeatures.ts from catalogued selenographic coordinates. */');
  lines.push('float lunarAlbedo(vec3 sel) {');
  lines.push('  float dark = 0.0;');
  for (const m of LUNAR_MARIA) {
    const [x, y, z] = selenographicDirection(m.lonDeg, m.latDeg);
    const r = featureAngularRadius(m.diameterKm);
    // A soft edge from 82 % to 108 % of the catalogued radius: the maria have
    // real shorelines, but not ones a disc can claim to know, and a hard rim
    // would claim exactly that.
    const cosInner = Math.cos(r * 0.82);
    const cosOuter = Math.cos(Math.min(Math.PI, r * 1.08));
    lines.push(
      `  dark += ${f(m.darkness)} * smoothstep(${f(cosOuter)}, ${f(cosInner)}, ` +
        `dot(sel, vec3(${f(x)}, ${f(y)}, ${f(z)})));  // ${m.name}`,
    );
  }
  lines.push('  float bright = 0.0;');
  for (const c of LUNAR_RAY_CRATERS) {
    const [x, y, z] = selenographicDirection(c.lonDeg, c.latDeg);
    const r = featureAngularRadius(c.raySpanKm);
    const cosOuter = Math.cos(Math.min(Math.PI, r));
    lines.push(
      `  bright += ${f(c.brightness)} * pow(smoothstep(${f(cosOuter)}, 1.0, ` +
        `dot(sel, vec3(${f(x)}, ${f(y)}, ${f(z)}))), 2.0);  // ${c.name}`,
    );
  }
  // Clamped so overlapping basins cannot drive the surface to black: the real
  // contrast between mare and highland is about two to three, not two to zero.
  lines.push('  return clamp(1.0 - min(dark, 0.62) + bright, 0.3, 1.3);');
  lines.push('}');
  return lines.join('\n');
}
