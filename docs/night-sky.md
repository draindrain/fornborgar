# The night sky

*How the sun's disc, the moon and the stars are placed and drawn, what the water
reflects, and — the part that matters — what each of them gets wrong.*

Phase 10 computed where the sun is. This is everything that follows from
actually drawing it, and from the fact that once the sun can set, there has to
be something up there when it does.

---

## 1. One clock for the whole sky

Phase 10's central decision was that **time of day is local apparent solar
time** — sundial time. The sun's hour angle is then `15° × (t − 12)` *by
definition*, which is what removed the equation of time, the time zone, the
site's longitude and ΔT from the sun's position.

That decision keeps paying. Sidereal time is the sun's hour angle plus the sun's
right ascension:

```
LAST = 15° × (t − 12) + α_sun
```

so the entire celestial sphere hangs off the clock the sliders already set, with
no second time system, no sidereal epoch and no longitude. `solar.ts` gained
`rightAscensionDeg` and `localApparentSiderealDeg` and nothing else had to
change.

The rotation from the equator of date into the scene's own frame (`+x` east,
`+y` up, `+z` south) is one 3×3 matrix, `equatorialToWorldMatrix(lat, LAST)`.
It is the whole diurnal rotation: the star field is a group carrying it, so
dragging the time-of-day slider rewrites nine numbers and touches no vertex
data. `tests/precession.test.ts` checks that matrix against `solarPosition`
itself — two entirely separate code paths that have to land the sun in the same
place, and do, to 1e-9.

## 2. The moon, and the return of ΔT

The moon does not get the gift the sun got. Its hour angle is

```
H_moon = 15° × (t − 12) + α_sun − α_moon
```

and `α_moon` exists only on a **dynamical** timescale. The map from the sundial
to that scale is ΔT, so ΔT is back.

It is not a small correction. At 1050 BCE, ΔT is **7.3 hours**; the moon moves
0.55°/h, so ignoring it would put the moon about **4° out** — eight lunar
diameters — and shift its phase by a few hours. `sky/deltaT.ts` applies the
Espenak–Meeus polynomial set (the standard fit for ancient eclipse work, resting
on Morrison & Stephenson's pre-telescopic timings). Three branches cover the
whole year slider; each branch's constant term is its own check value (10583.6 s
at year 0, 1574.2 s at 1000 CE), and the branches join to under a second.

What remains is the uncertainty *in* ΔT — of order twenty minutes at 1000 BCE,
which is about 0.2° of lunar longitude, under half a lunar diameter. That is a
tenth of the error the correction removes, and the methods panel says so.

**Position** is Meeus ch. 47 — the truncated ELP-2000/82, 120 rows of periodic
terms in `sky/lunarTables.ts`. Those rows are the one place in this codebase
where a single mistyped digit would move the moon and nothing would complain, so
the gate is Meeus's own worked **Example 47.a**: 1992 April 12.0 TD must give
λ = 133.162655°, β = −3.229126°, Δ = 368409.7 km. It does, to his printed
precision.

**Topocentric parallax** (Meeus ch. 40) is applied. The moon's horizontal
parallax is about 0.95° — nearly *twice its own diameter* — so a geocentric moon
sits visibly too high whenever it is low, which is exactly when anyone looks at
it. The correction is made in the horizontal frame as a shift along the vertical
circle, which is the same thing as the right-ascension/declination form to
within a few arcseconds and avoids carrying a second coordinate conversion.

Not modelled, all far below the ~0.01° the rest is good to: nutation in
longitude (17″, and it would have to move the sun too) and the topocentric
enlargement of the disc when the moon is overhead (1.7 %).

## 3. Drawing the moon

There is no phase angle anywhere in this codebase, and no position angle of the
bright limb. For each pixel inside the disc the fragment shader reconstructs the
point on the lunar sphere it is looking at, and lights that point with the sun's
direction. The illuminated fraction and the tilt of the terminator are then
consequences of where the two bodies are, not quantities anyone computed.

Three details that are easy to get wrong, and two of which were, first time:

- **The normal points back at the observer.** `uMoonDir` points *away* from the
  eye, so the visible hemisphere is the one whose normals have a negative
  component along it. The plus sign draws every phase mirrored.
- **The glare goes outside the limb.** It belongs to the atmosphere and the eye,
  not to the moon. Adding it across the disc floods the unlit side with grey and
  destroys the phase.
- **The reflectance is Lommel–Seeliger, not Lambert.** The moon is a rough
  regolith; a full moon is far brighter than twice a half moon, and that is why
  it reads as a flat disc rather than as a ball.

The moon is lit by the sun's **geometric** direction while its disc is drawn at
the **refracted** one, because refraction bends the light that reaches us, not
the light that reaches the moon.

### The face

A blank disc is wrong in a way people notice immediately: the near side of the
moon is the same arrangement of maria every night, and has been for three
billion years, so the Iron Age sky had exactly the face we see.

`sky/lunarFeatures.ts` carries fourteen maria and four ray craters at their
catalogued selenographic coordinates, sized by their catalogued diameters, and
generates the albedo lookup as GLSL. There is no noise, no procedural mottling
and no photograph — but it is a **schematic of the moon's face, not an image of
it**: the maria are irregular and a soft-edged disc is an approximation of an
outline. It is called a schematic in the methods panel for that reason.

North comes from the ecliptic pole, which stands in for the moon's rotation axis
to within 1.54°, so the face is the right way up and the right way round.
**Libration is not modelled** — the rocking of up to about 7° in each direction
that lets us see 59 % of the surface rather than half of it — so the face never
turns.

## 4. The stars

5 044 stars to visual magnitude 6.0: the naked-eye limit, and therefore the
right limit for a sky with no light pollution in it.

**Provenance** is in `app/public/data/sky/DATA-LICENSES.md`: XHIP (Anderson &
Francis 2012, VizieR V/137D), built on Hipparcos, obtained through the derived
data set published with d3-celestial. 80 kB, committed, and read by *column
name* so a catalogue that later ships proper motions is a data change with no
app change.

**Precession** is Meeus ch. 21 rigorous (IAU 1976), and deliberately *not* a
long-term model. The obliquity in `solar.ts` had to be Laskar's because it
enters the sun's declination directly and the standard polynomial misbehaves
outside ±2000 years; precession is a different case. Over the ±3050 years this
app reaches, IAU 1976 departs from Vondrák et al. (2011) by of order an
arcminute — a thirtieth of the size a first-magnitude star is drawn at, and
three orders of magnitude below the error already being carried below. Reaching
for the long-term model here would be precision spent in the wrong place.

The check on it is historical rather than numerical: run the year back and the
north celestial pole has to arrive at **Thuban**, α Draconis, around 2700 BCE.
It does. And at 1050 BCE, the far end of this app's slider, it is near neither
Thuban nor Polaris — **the Iron Age had no pole star**, which is worth knowing
before drawing conclusions about what a rampart was aligned on.

### What proper motion costs

The derived catalogue does not carry proper motion, so it is not applied.
Precession, which moves the whole sky, is by far the larger effect and *is*
applied. What is left is that a few nearby stars are drawn where they were in
2000 CE rather than where they were in the Iron Age. Over 3050 years:

| Star | Proper motion | Displacement at 1050 BCE |
|---|---|---|
| 61 Cygni | 5.28″/yr | ≈ 4.5° |
| μ Cassiopeiae | 3.77″/yr | ≈ 3.2° |
| Arcturus | 2.28″/yr | ≈ 1.9° |
| Sirius | 1.34″/yr | ≈ 1.1° |
| Procyon | 1.26″/yr | ≈ 1.1° |
| Vega | 0.35″/yr | ≈ 0.3° |

Essentially everything else is well under half a degree. This is a distortion in
the shape of a few constellations, not a wrong sky — but it is the *largest*
error in the whole night sky, an order of magnitude past anything the precession
model choice is worth, and it is stated in the methods panel with these numbers.

### Two representations

Stars are drawn as `THREE.Points` — crisp at any zoom, one draw call, per-star
magnitude and B−V colour. They depth-test at the far plane, unlike the sky dome,
because a transparent material is always drawn after the opaque pass and would
otherwise shine straight through the terrain.

The **water** cannot use points: a reflection needs a *function of direction*.
So the same epoch directions are also splatted, on the CPU, into a small
equirectangular map in equatorial coordinates, which the water samples through
the inverse of the same rotation the point field uses. It is small on purpose —
a rippled surface smears the stars anyway, which is what water does to them —
and it is a pure function, so `tests/stars.test.ts` can assert that a star lands
in the texel its right ascension says without a GL context anywhere.

It is rebaked only when the year moves by more than 50 years: precession is
0.014°/yr, so fifty years is one texel of a 512×256 map, and rebaking more often
would cost a hitch mid-drag to move stars by less than the width of the texel
they sit in.

### When they are out

The limiting magnitude rises as the sky darkens, the way it does outdoors: a
couple of first-magnitude stars at civil twilight, the whole catalogue only once
the sun is below −18°. The last few degrees of atmosphere put out everything
faint, so stars thin toward the horizon.

## 5. The sky itself

The sky used to be a flat `scene.background` colour, and the fog was set to
exactly the same colour — which is what made the fog wall at the horizon
invisible. A gradient could easily have broken that, so it is built not to:

> `skyGradient` returns **exactly `uSkyHorizon` at `dir.y == 0`**, and
> `uSkyHorizon` *is* `Atmosphere.state.sky`, which *is* the fog colour.

The gradient only departs from the fog colour going up. `scene.background` is
still set and still tracks the same value, so a dome that failed to draw would
degrade to the old flat sky rather than to black.

The one exception is the sun's aureole, which reaches the horizon because that
is where a sunset is. That leaves a bounded mismatch at the sun's azimuth: at
sunset, distant terrain fades to one flat colour while the sky just above it is
orange. Closing it would mean **sky-matched fog** — replacing `#include
<fog_fragment>` in the terrain, vegetation, impostor and palisade materials with
one that evaluates `skyGradient()` along the view direction, giving true aerial
perspective. That is a real improvement and a real risk (it touches every
chained `onBeforeCompile` injection in the codebase, and needs an
instancing-aware world position for the vegetation), and it is deliberately not
in this change.

The dome is drawn with no depth test, no fog and no tone mapping, camera
translation stripped and vertices pushed to the far plane, so it is independent
of its own radius, of a near plane that can be 0.5 m, of a far plane that can be
96 km, and of the logarithmic depth buffer.

## 6. What the water reflects

**The sky, not the landscape.** The hills, the trees and the palisade do not
appear in the water, by design.

A true mirror would mean a second render of the whole scene from a mirrored
camera every frame — with 150 000 instanced trees and a 96 km far plane, that is
roughly a doubling of frame cost, and it would still need the sky to be a real
object to reflect the sky at all. Instead the water compiles **the same GLSL
chunk the dome does**, with **the same uniform objects shared by reference**, and
evaluates it along the reflected ray. The sunset in the water is therefore the
same sunset that is in the sky, by construction rather than by tuning.

What changed in `water/water.ts`:

- **Real Fresnel.** Schlick with n = 1.33: two per cent looking straight down, a
  mirror at grazing. The old `pow(1 - |viewDir.y|, 4)` had roughly this shape and
  none of the consequences — in particular it could not carry a reflection.
- **Wave normals.** Three crossing wave trains (about 6 m, 2.4 m and 1.1 m),
  summed as slopes rather than heights, since the surface stays geometrically
  flat and only its normal moves. They fade out with distance, and what the fade
  takes away is handed to the specular lobe's **roughness** — which is the line
  that turns the sun's half-degree disc into a glitter path, and which stops a
  64 km plane of per-pixel wave normals from shimmering into aliasing.
- **No tone mapping.** The sky has never been tone-mapped, so a tone-mapped
  reflection of it would disagree with it exactly at the horizon line where the
  two meet. The shader drops `tonemapping_fragment` and the *body* of the water
  carries `toneMappingExposure` by hand instead; the reflection does not, because
  a reflected sunset is as bright as the sunset.
- `uWaterSheen`, a hardcoded `#b6d2dd` that never knew what the sky was doing,
  is gone.

## 7. What is not in the sky

**No planets.** Venus at magnitude −4 would be the brightest thing up there
after the moon, and Jupiter, Mars and Saturn all outshine most of the stars that
*are* drawn. A truncated VSOP87 is a much larger table than ch. 47 and would want
the same worked-example gate; until it exists, the absence is stated rather than
glossed.

**No Milky Way**, which would dominate an unlit Iron Age sky. The only source
reachable offline is the outline catalogue published with d3-celestial, whose
licence is not stated anywhere checkable; a repository that ships a
`DATA-LICENSES.md` per site does not get to hand-wave that one.

**No atmospheric refraction of the star field**, no annual aberration (20″), and
no nutation — all an order of magnitude or more below the proper-motion error
above.

## 8. Verification

`app/scripts/verify-night-sky.mjs` drives a real Chromium through
`window.__app.time` and `window.__app.sky`, over a site with water, and asserts
the sky at five configurations: midsummer noon, sunset, civil twilight,
astronomical night with the moon up, and midwinter midday. Note that the orbit
rig clamps at 88° of polar angle and **cannot look up**, so anything aimed at the
sky has to go through first person.

The unit gates that would catch a real error rather than a typo are Meeus's
Example 47.a, the Thuban pole check, and the ΔT branch-continuity check.
