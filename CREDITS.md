# Credits & Licences

ASCENT is original work. Every external asset is used under a licence that permits it,
listed below. Processed derivatives live in `public/assets/`; the processing scripts are in
`scripts/` so every asset can be regenerated from its source.

## Imagery

| Asset (in `public/assets/`) | Source | Licence |
| --- | --- | --- |
| `earth/albedo.webp` (land) | NASA Visible Earth — *Blue Marble* (via the `vasturiano/three-globe` example images) | Public domain (NASA) |
| `earth/data.webp` (water mask, elevation) | NASA Visible Earth masks (via `turban/webgl-earth`) | Public domain (NASA) |
| `earth/night.webp`, `earth/clouds.webp` | [Solar System Scope](https://www.solarsystemscope.com/textures/) textures, distributed with the three.js examples (resized & merged by three.js) — re-graded, channel-split and converted | CC BY 4.0 — © INOVE / Solar System Scope, based on NASA imagery |
| `moon/albedo.webp`, `moon/height.webp`, `planets/{mercury,venus,mars,jupiter,saturn,saturn_ring,uranus,neptune,sun}.webp` | [Solar System Scope](https://www.solarsystemscope.com/textures/) 2k maps (via the `pyvista/data` repository) — converted; the Moon relief proxy is derived from the albedo | CC BY 4.0 — © INOVE / Solar System Scope |
| `planets/{io,europa,ganymede,callisto}.webp` | [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources) | Public domain (NASA) |
| `sky/milkyway.webp`, `sky/stardensity.png` | NASA 3D Resources *Tycho Star Map* — stars removed, denoised and re-projected to ecliptic coordinates | Public domain (NASA) |
| `sky/stars.bin` | Yale Bright Star Catalogue, 5th ed. (Hoffleit & Warren, 1991), JSON by `brettonw/YaleBrightStarCatalog` | Public domain data |

## Voice

All mission-control lines in `public/assets/audio/voice/` were synthesised offline for this
project with **Kokoro-82M** (hexgrad), licensed Apache-2.0. The weights came from the npm
package `kokoro-q8-shards` and the voice style vectors from `kokoro-js` (Apache-2.0).
`scripts/gen_voice.py` regenerates them from `scripts/voice_lines.json`. The radio treatment
(band-limiting, saturation, squelch, Quindar tones) is applied live by the game.

## Music & sound effects

All music and sound effects are synthesised procedurally at runtime with the Web Audio API.
They are original to this project.

## Fonts

- Barlow, Barlow Condensed and Barlow Semi Condensed by Jeremy Tribby — SIL Open Font Licence 1.1 (via `@fontsource`).
- JetBrains Mono by JetBrains — SIL Open Font Licence 1.1 (via `@fontsource`).

## Code & data references

- [three.js](https://threejs.org) — MIT.
- Planetary orbits: E. M. Standish, *Keplerian Elements for Approximate Positions of the Major Planets* (JPL Solar System Dynamics).
- Lunar mean elements: J. Meeus, *Astronomical Algorithms*, 2nd ed.
- Atmosphere: *U.S. Standard Atmosphere, 1976* (NOAA/NASA/USAF).
- Entry heating: Sutton & Graves (1971) convective correlation; Tauber & Sutton (1991) radiative correlation.
- Sky rendering follows S. Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique* (EGSR 2020).
- Vehicle performance figures are from public data for the real-world vehicle each original design is modelled on. All vehicle names, liveries and logos are fictional.
