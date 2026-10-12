# ASCENT — a cinematic spaceflight simulator

ASCENT is a browser spaceflight simulator built on three.js and WebGL2. It flies real orbital
mechanics and presents them like a film. A flight runs as one continuous sequence:

- the terminal count and the thirteen-step ignition sequence
- liftoff into a cloud of steam
- staging, booster recovery and the silence of orbit
- travel to the Moon or Jupiter
- a plasma-wrapped reentry ending under parachutes

Everything you see and hear is generated at runtime, apart from a handful of public-domain and
CC BY planetary textures and synthesised voice lines (see [CREDITS.md](CREDITS.md)). That
includes the rockets, the launch complexes, the exhaust, the music and the sound.

## Playing it in the browser

The game is published to GitHub Pages on every push to `main`:
**https://zdawg12349-cell.github.io/Space-ship/**. It runs on any computer with a WebGL2
browser, Chromebooks included; nothing to install.

## Running it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # type-check + production build in dist/
npm test           # physics, guidance, planner and mission tests (vitest)
```

The game needs a WebGL2 browser. On first launch it picks a graphics preset for your GPU; you
can change it under **Settings**.

## What's in it

### Flights and missions

There are eleven missions plus a free sandbox.

**Goals (press Y):** choose what the flight should do and the autopilot flies all of it, using
the same manoeuvre buttons you would: *Orbit, then come home* (deorbit burn, entry,
parachutes), *Around the Moon and home*, *Land on the Moon*, or *Leave the Moon, come home*.
Only the goals that make sense for the vehicle and where it is are offered. Each mission starts
on the goal it is about, and the panel at the top shows the step being flown. On every flight
with parachutes, tips walk you through the way home: the deorbit burn, entry, and when to press
<kbd>U</kbd> for the parachutes.


| # | Mission | Vehicle | What happens |
| --- | --- | --- | --- |
| 1 | First Light | SPARROW | Tutorial: countdown, ignition, max-Q, space |
| 2 | Low Earth Orbit | KESTREL 9 | Orbit, deploy the satellite, land the booster |
| 3 | Return to Sender | KESTREL 9 | Booster boostback and landing at LZ-1 |
| 4 | Twin Boosters | KESTREL HEAVY | Side boosters land side by side; the core lands on the drone ship |
| 5 | Night Flight | MERIDIAN 421 | Solid boosters in the dark |
| 6 | Crew Rotation | VOSTOK-R | Steppe launch through an overcast, orbit, a deorbit aimed at the steppe, guided entry, soft landing |
| 7 | Catch | LEVIATHAN | The launch tower catches the returning booster |
| 8 | Free Return | COLOSSUS V | Sunrise launch window, TLI, course correction, lunar flyby |
| 9 | Tranquility | Lunar lander | Powered descent to the Sea of Tranquility |
| 10 | Homeward | Lunar ascent vehicle | Lunar liftoff, a return aimed at an ocean recovery zone, guided 11 km/s entry, splashdown |
| 11 | King of Planets | Juno-class probe | Jupiter orbit insertion past the Galilean moons |

In the **sandbox** you choose any rocket, launch site, time of day and weather. A flight can
begin on the pad, already in Earth orbit (upper stage and payload only), or at entry interface
(the crew capsule alone).

### Sixteen launchers

| Vehicle | Class | Inspired by |
| --- | --- | --- |
| SPARROW | Small launcher | Electron |
| KESTREL 9 | Reusable launcher | Falcon 9 Block 5 |
| MERIDIAN 421 | Medium launcher | Atlas V 421 |
| AURORA HEAVY | Heavy-lift launcher | Delta IV Heavy |
| LEVIATHAN | Super-heavy launcher | Starship / Super Heavy |
| VOSTOK-R | Crew launcher | Soyuz-2.1a / Soyuz MS |
| EUROPA 5 | Cargo launcher | Ariane 5 ECA |
| COLOSSUS V | Lunar launcher | Saturn V / Apollo |
| PATHFINDER | Deep-space launcher | Atlas V 551 + Star 48B |
| NOVA X | Experimental SSTO | DC-X / X-33 lineage |
| GARUDA XL | Multi-stage launcher | PSLV-XL |
| HYDRA 3B | Side-booster launcher | Long March 3B |
| KESTREL HEAVY | Heavy reusable launcher | Falcon Heavy |
| CORVID 7925 | Satellite launcher | Delta II 7925 |
| ODYSSEY | Exploration launcher | SLS Block 1 + Orion |
| PROMETHEUS | Exploration launcher | Heavy booster + nuclear-thermal upper stage |

Each vehicle is a set of assemblies, built from tanks, interstages, fairings, capsules and
engines with real masses, propellant loads, thrust and specific impulse. Its geometry and
materials are generated from that definition.

### Physics

- **Orbits:** patched-conic two-body mechanics in double precision. Propagation uses universal
  variables, sphere-of-influence transitions are bisected to the crossing, and on-rails time
  warp goes up to 1,000,000×.
- **Vehicles:** six-degree-of-freedom rigid bodies covering staging and separation impulses,
  gimbal, RCS, reaction wheels, grid fins and flaps.
- **Atmosphere and loads:** US Standard Atmosphere 1976 with wind and turbulence. Aerodynamics
  use Barrowman normal forces, cross-flow drag and transonic drag rise. Structural q·α,
  dynamic-pressure and g limits apply.
- **Heating:** Sutton–Graves convective and Tauber–Sutton radiative entry heating, ablative and
  reusable heat shields, and parachutes.
- **Guidance:**
  - Closed-loop ascent guidance with launch-window plane targeting.
  - Lambert-targeted manoeuvre execution, using velocity-to-be-gained steering. Small
    corrections, and the last fraction of a second of big burns, are flown on RCS
    translation. A stage whose engine has used its ignitions hands over to the spacecraft.
  - A planner for deorbit, circularise, translunar and trans-Earth injection, mid-course
    corrections and Jupiter capture. Deorbit burns can aim at a landing site, searching
    several days of passes. Trans-Earth injection weighs every return that grazes the entry
    corridor and picks the cheapest one whose entry comes down in open ocean.
  - Guided capsule entry: a predictor-corrector picks the bank angle for the capsule's lift,
    with bank reversals for cross-range. Crews come down on the Kazakh steppe. Returning
    from the Moon, the first plunge is flown lift-up to hold the peak near 6 g, the
    predictor rules out skip-outs, and capsules built for the sea pick a splashdown point
    in open water if none was planned or the planned one is out of reach.
  - Lunar descent and ascent autopilots.
  - Booster recovery: boostback, an entry burn steered with a burn-aware impact predictor,
    and glide steering that uses the stage's real lift curve (a blunt body falling engines
    first lifts away from its tilt at small angles). The impact predictor includes the wind,
    and terminal landing guidance is zero-miss. Landing pads, a drone ship stationed under
    the predicted impact point, and tower catches.

### Rendering

- **Planets and sky:** quadtree planet terrain from real elevation data. The atmosphere is
  physically based (after Hillaire 2020), with sunsets that depend on altitude. Clouds, ocean
  and city lights complete the Earth. Seen at a low angle the sea mirrors the sky, and the sun
  glitters on it only along its own path.
- **Shadows:** vehicles, towers, masts and buildings cast sun shadows onto the ground around
  them (grass, sand and pads alike), and a lander's shadow falls black on the lunar regolith.
- **Weather:** a volumetric cloud deck over the region around the camera, ray-marched at half
  resolution. Clear and fair skies have fair-weather cumulus, breezy skies broken cloud,
  overcast skies a grey stratus sheet, and storms towering cells with rain and lightning.
  - The same atmosphere that lights the sky lights the cloud, so it takes sunset colours,
    the orange of town lights at night, and the glare of the exhaust as a rocket climbs
    through. Skylight comes from the whole blue dome, so shaded sides and bases stay
    grey-blue under a low sun rather than turning brown.
  - Clouds drift with the wind and cast moving shadows on the ground. Broken cloud adds its
    own bright light to the day, so shadowed ground and vehicles are not lit by blue sky
    alone.
  - An overcast takes away the direct sun. The ground and everything beneath it are lit by
    the grey base the camera sees, and a storm's deep base is darker still.
  - A climbing rocket punches a channel through the deck that slowly spreads.
  - Fair-weather cumulus have flat bases and domed tops, each cell's core standing above its
    edges, so from altitude a low sun picks out every cloud.
  - From high up the planet-wide cloud layer takes over, from the horizon inward as the camera
    climbs, with each cloud drawn by one or the other. Around the launch site the layer keeps the
    local weather's own cells, with their parallax and their shaded flanks, so the hand-over
    shows no second layer and a fair day stays fair all the way to orbit.
- **Moon and planets:** the Moon, and Jupiter with its banded atmosphere and Galilean moons.
- **Image pipeline:** HDR rendering with auto-exposure, AgX tone mapping, energy-conserving
  bloom and a night colour grade.
- **Exhaust:**
  - Ray-marched exhaust plumes that respond to ambient pressure, with shock diamonds and
    vacuum expansion.
  - Lit particle systems for steam, smoke, deluge water, cryogenic venting, ground clouds and
    exhaust trails. Each puff is a cauliflower billow whose outline is eroded by slowly boiling
    noise, lit by the sun and by the flame, with grey shadowed sides. Slow eddies fold the
    cloud as it spreads, and old puffs loosen into wisps.
  - Lighter presets draw the smoke at reduced resolution and upsample it against the scene's
    depth, so the tower and the rocket keep crisp edges in front of it.
  - A vacuum plume is a faint glow, and however far a line of sight runs down a jet its glow
    cannot pile up far past the core's own brightness, so a camera on the stage looking aft is
    not blinded by its own engine.
- **Flight effects:** transonic vapour cones, entry plasma sheaths, heat shimmer, stage
  break-ups and booster burn-up. RCS jets fire from the thruster pods themselves: in air, white
  puffs that the air soon stops; in vacuum, a bright cone at the nozzle that flashes out into
  a thin haze.
- **Launch complexes:** procedural sites with towers, swing arms, flame trenches, lightning
  masts, floodlights and an integration hangar in profiled steel. Each site has
  climate-specific vegetation that bends in the wind. Tree crowns break up into tufts close
  to the camera, and their leaves glow when the sun is behind them.
  - After dark, floods over the hangar doors, wall packs and road lamps throw pools of light
    on the concrete, the roads, the walls and the plants around them. They are lit through
    each material's own shading, at no cost to the rest of the scene.
- **Recovery hardware:** landing-zone pads and the drone ship.

### Cinematography and sound

- **Camera:** an automatic camera director with more than thirty shot types, cued by flight
  events, among them a camera hovering above the cloud tops as the rocket bursts out. Camera
  shake models sound arriving at the speed of sound, vibration, dynamic pressure and the lens in
  use. Ground cameras find a clear line of sight through the trees.
  - When the director cuts away to a booster coming home, the lighting, shadows, particles
    and airflow sound follow it. Pressing P there opens photo mode around the booster.
- **Other camera modes:** chase, orbit, onboard, ground-tracking and free cameras, plus a photo
  mode.
- **Sound:** layered engine sound with distance delay, Doppler and air absorption, mixed to
  stay audible on laptop speakers. Rain hisses on the pad, and thunder cracks or rolls in at
  the speed of sound after each flash. Up close, reaction-control thrusters hiss as they pulse,
  and landing legs thump out on their actuators and lock. Mission-control radio reacts to
  flight events, with Quindar tones. The music is an adaptive score that falls to a hush after
  orbit insertion.
  - **Engine sound in space** (Settings, on by default) keeps a muffled rumble on outside
    cameras in vacuum, as films do. Turn it off for a silent vacuum.

## Controls

| Key | Action |
| --- | --- |
| Space | Stage |
| Shift / Ctrl, Z / X | Throttle up / down, full / cut |
| W S · A D · Q E | Pitch · yaw · roll |
| I K · J L · Y N | RCS translation |
| T | Stability assist |
| 1 – 0, O | Autopilot modes, orbit assist |
| R · G · U | RCS · landing legs · parachutes |
| , . / | Time warp down / up / reset |
| C · V | Camera mode · onboard camera |
| Mouse drag / wheel | Orbit / zoom the camera |
| M | Orbital map |
| H | Cinematic mode (HUD off) |
| P | Photo mode |
| Enter · Backspace | Skip the count to T-10 · hold the count |
| B | Abort (crewed vehicles) |
| F5 · F2 · F1 | Quick save · screenshot · controls |
| Esc | Pause |

The nav panel on the right offers context-sensitive manoeuvres when they apply:
- plan TLI
- plan a deorbit
- circularise
- course correction
- warp to the Moon
- descent assist
- ascent to orbit
- return to Earth
- orbit insertion

## Graphics presets

| Preset | For |
| --- | --- |
| LOW | Integrated GPUs and software rendering |
| MEDIUM | Laptops |
| HIGH | Desktop GPUs (default) |
| ULTRA | High-end GPUs: 4K shadows, more particles and terrain detail |
| CINEMATIC | Screenshots and video: 8× MSAA, maximum particles, stronger grain and vignette |

## Project layout

```
src/
  physics/   bodies & ephemerides, orbits, Lambert, vessel 6-DOF, aero, heating, world & warp
  vehicles/  launcher catalogue and engine data
  game/      flight session, guidance, autopilot, planner, recovery, missions, saves, settings
  render/    planets, atmosphere, post-processing, vehicles, launch complexes, recovery zones
  fx/        plumes, particles, effects, aero shells (vapour cone, plasma)
  camera/    cinematic director and camera shake
  audio/     engine sound, radio, adaptive music
  ui/        menus, HUD, map, photo mode, tutorial
tests/       vitest suites (physics, ascent of every rocket, recovery, missions, reentry)
scripts/     headless test drivers (screenshots, mission runs) and asset pipeline
```

Headless checks use Playwright with the bundled Chromium:

```bash
scripts/with-build.sh /tmp/ascent-dist node scripts/missions.mjs crew landing   # fly missions end to end
scripts/with-build.sh /tmp/ascent-dist node scripts/app.mjs out '[{"mission":"leo"},{"advance":20},{"shot":"pad"}]'
```

## Licence notes

Code and procedural content are original. Third-party data and imagery are public domain or
CC BY 4.0, and the fonts are SIL OFL; [CREDITS.md](CREDITS.md) has the full list.
