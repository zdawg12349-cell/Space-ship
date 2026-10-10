import type { LandingTarget } from './Planner';
import type { WeatherKind } from './providers';

/**
 * Mission catalogue: eleven missions forming one arc from a first sub-orbital hop to Jupiter,
 * plus the sandbox. Objectives are evaluated by the MissionDirector against the live flight.
 */

export type MissionStart = 'pad' | 'leo' | 'lunarOrbit' | 'moonSurface' | 'jupiterApproach' | 'entry';

export type ObjectiveKind =
  | 'liftoff' | 'maxq' | 'karman' | 'orbit' | 'payload' | 'boosterLanded' | 'allBoostersLanded' | 'towerCatch' | 'srbSep' | 'lesJettison'
  | 'deorbit' | 'survivedEntry' | 'chutes' | 'softLanding' | 'splashdown' | 'tli' | 'moonSoi' | 'moonFlyby' | 'earthReturn'
  | 'lunarTouchdown' | 'lunarLiftoff' | 'lunarOrbit' | 'tei' | 'jupiterSoi' | 'perijove' | 'joi' | 'nightLaunch' | 'fairing'
  | 'droneshipLanding';

export interface ObjectiveDef {
  kind: ObjectiveKind;
  text: string;
  optional?: boolean;
  /** numeric parameter (altitude, distance...) */
  param?: number;
}

export interface MissionDef {
  id: string;
  number: number;
  title: string;
  subtitle: string;
  briefing: string;
  vehicle: string;
  site: string;
  /** launch date/time (UTC ISO) */
  date: string;
  weather: WeatherKind;
  targetOrbit?: number;
  inclination?: number;
  /** launch into the plane containing the Moon at arrival */
  planeTarget?: 'moon';
  /** where a crewed return should come down (the deorbit planner and entry guidance aim here) */
  landingTarget?: LandingTarget;
  countdownStart: number;
  orbitAssist: boolean;
  recovery: boolean;
  start: MissionStart;
  objectives: ObjectiveDef[];
  tutorial?: boolean;
  tags: string[];
  /** music mood */
  mood: 'hope' | 'tension' | 'wonder' | 'night';
}

export const MISSIONS: MissionDef[] = [
  {
    id: 'first_light', number: 1, title: 'First Light', subtitle: 'Tutorial · Sub-orbital to space',
    briefing: 'Your first flight. A small kerosene launcher stands on the coast at dawn. Follow the terminal count, watch the ignition sequence, and ride it through the sound barrier and maximum dynamic pressure to the edge of space. The flight computer will fly the ascent; you will learn the controls, cameras and staging on the way up.',
    vehicle: 'sparrow', site: 'cape', date: '2026-10-07T10:58:00Z', weather: 'clear', countdownStart: -60, orbitAssist: true, recovery: false, start: 'pad', tutorial: true,
    objectives: [{ kind: 'liftoff', text: 'Liftoff' }, { kind: 'maxq', text: 'Survive maximum dynamic pressure' }, { kind: 'karman', text: 'Cross the Kármán line (100 km)' }, { kind: 'orbit', text: 'Reach orbit', optional: true }],
    tags: ['Tutorial', 'Small launcher'], mood: 'hope',
  },
  {
    id: 'leo', number: 2, title: 'Low Earth Orbit', subtitle: 'Commercial satellite deployment',
    briefing: 'A communications satellite rides a nine-engine kerosene workhorse to a 220 km parking orbit. Reach orbit, deploy the payload and, if you can, bring the first stage home to the landing zone beside the Cape.',
    vehicle: 'kestrel9', site: 'cape', date: '2026-10-06T21:30:00Z', weather: 'fair', targetOrbit: 220_000, countdownStart: -120, orbitAssist: true, recovery: true, start: 'pad',
    objectives: [{ kind: 'orbit', text: 'Reach a stable orbit (perigee > 180 km)', param: 180_000 }, { kind: 'payload', text: 'Deploy the satellite' }, { kind: 'boosterLanded', text: 'Land the first stage', optional: true }],
    tags: ['Orbit', 'Reusable'], mood: 'hope',
  },
  {
    id: 'rtls', number: 3, title: 'Return to Sender', subtitle: 'Booster recovery',
    briefing: 'Same rocket, harder job. Separation at the edge of space, a flip, a boostback burn against the vehicle\'s own momentum, an entry burn through the thickening air, grid fins, and a single-engine landing burn timed to reach zero velocity exactly at the pad. The booster flies itself — keep your eyes on it.',
    vehicle: 'kestrel9', site: 'cape', date: '2026-10-07T23:41:00Z', weather: 'clear', targetOrbit: 220_000, countdownStart: -60, orbitAssist: true, recovery: true, start: 'pad',
    objectives: [{ kind: 'boosterLanded', text: 'First stage lands at LZ-1' }, { kind: 'orbit', text: 'Second stage reaches orbit' }],
    tags: ['Recovery', 'Night'], mood: 'tension',
  },
  {
    id: 'heavy', number: 4, title: 'Twin Boosters', subtitle: 'Heavy lift · simultaneous landings',
    briefing: 'Three cores lit together. The two side boosters peel away, flip and fly back to land side by side seconds apart, while the centre core pushes on and lands on a drone ship far downrange.',
    vehicle: 'kestrel_heavy', site: 'cape', date: '2026-10-08T15:45:00Z', weather: 'fair', targetOrbit: 250_000, countdownStart: -60, orbitAssist: true, recovery: true, start: 'pad',
    objectives: [{ kind: 'allBoostersLanded', text: 'Both side boosters land' }, { kind: 'orbit', text: 'Payload reaches orbit' }, { kind: 'droneshipLanding', text: 'Centre core lands on the drone ship', optional: true }],
    tags: ['Heavy', 'Recovery'], mood: 'wonder',
  },
  {
    id: 'night', number: 5, title: 'Night Flight', subtitle: 'Solid boosters after midnight',
    briefing: 'A bronze-coloured core with two solid boosters on a moonless night. The solids turn night into day for two minutes. Watch them burn out and fall away, then follow the hydrogen upper stage, nearly invisible against the stars.',
    vehicle: 'meridian', site: 'cape', date: '2026-10-08T05:10:00Z', weather: 'clear', targetOrbit: 240_000, countdownStart: -60, orbitAssist: true, recovery: false, start: 'pad',
    objectives: [{ kind: 'nightLaunch', text: 'Launch in darkness' }, { kind: 'srbSep', text: 'Solid booster separation' }, { kind: 'orbit', text: 'Reach orbit' }],
    tags: ['Night', 'Solid boosters'], mood: 'night',
  },
  {
    id: 'crew', number: 6, title: 'Crew Rotation', subtitle: 'Steppe launch · orbit · return',
    briefing: 'Three crew on the steppe, a four-booster kerosene rocket and a launch escape tower. Reach orbit, then bring them home: a retrograde deorbit burn, the fireball of entry, parachutes and a soft-landing burn on the grassland.',
    vehicle: 'vostok', site: 'baikonur', date: '2026-10-07T08:12:00Z', weather: 'fair', targetOrbit: 210_000, inclination: 51.6, countdownStart: -60, orbitAssist: true, recovery: false, start: 'pad',
    landingTarget: { lat: 47.36, lon: 69.6, name: 'the Kazakh steppe' },
    objectives: [{ kind: 'lesJettison', text: 'Escape tower jettison' }, { kind: 'orbit', text: 'Reach orbit' }, { kind: 'deorbit', text: 'Deorbit burn' }, { kind: 'survivedEntry', text: 'Survive entry' }, { kind: 'softLanding', text: 'Land the crew safely' }],
    tags: ['Crew', 'Reentry'], mood: 'tension',
  },
  {
    id: 'superheavy', number: 7, title: 'Catch', subtitle: 'Super-heavy · tower catch',
    briefing: 'Thirty-three methane engines, the largest rocket ever to fly. After staging, the booster flies back to the launch tower, where two mechanical arms close around it in mid-air. The ship continues to orbit.',
    vehicle: 'leviathan', site: 'boca', date: '2026-10-09T13:00:00Z', weather: 'breezy', targetOrbit: 200_000, countdownStart: -60, orbitAssist: true, recovery: true, start: 'pad',
    objectives: [{ kind: 'towerCatch', text: 'Booster caught by the tower' }, { kind: 'orbit', text: 'Ship reaches orbit' }],
    tags: ['Super-heavy', 'Recovery'], mood: 'wonder',
  },
  {
    id: 'flyby', number: 8, title: 'Free Return', subtitle: 'Lunar flyby',
    briefing: 'A three-stage lunar rocket. Reach a parking orbit, light the third stage again for translunar injection, coast for three days and swing around the far side of the Moon — the Earth setting behind the lunar horizon — then fall home.',
    vehicle: 'colossus', site: 'cape', date: '2026-10-10T11:39:00Z', weather: 'clear', targetOrbit: 190_000, planeTarget: 'moon', countdownStart: -60, orbitAssist: true, recovery: false, start: 'pad',
    objectives: [{ kind: 'orbit', text: 'Parking orbit' }, { kind: 'tli', text: 'Translunar injection' }, { kind: 'moonSoi', text: 'Enter the Moon\'s sphere of influence' }, { kind: 'moonFlyby', text: 'Fly within 1,000 km of the Moon', param: 1_000_000 }, { kind: 'earthReturn', text: 'Return toward Earth', optional: true }],
    tags: ['Moon', 'Transfer'], mood: 'wonder',
  },
  {
    id: 'landing', number: 9, title: 'Tranquility', subtitle: 'Powered descent to the lunar surface',
    briefing: 'Lunar orbit, 100 km. Undock, burn retrograde to start the descent and fly the lander down onto the Sea of Tranquility. Watch the radar altitude, keep the descent rate under control and land gently with fuel to spare.',
    vehicle: 'selene', site: 'cape', date: '2026-10-17T07:15:00Z', weather: 'clear', countdownStart: 0, orbitAssist: false, recovery: false, start: 'lunarOrbit',
    objectives: [{ kind: 'lunarTouchdown', text: 'Touch down on the Moon (< 3 m/s)', param: 3 }],
    tags: ['Moon', 'Landing'], mood: 'tension',
  },
  {
    id: 'homeward', number: 10, title: 'Homeward', subtitle: 'Lunar liftoff · return · entry',
    briefing: 'You are on the lunar surface. Lift off, reach lunar orbit, burn for home and ride the hottest reentry in the game — eleven kilometres per second — under parachutes to an ocean splashdown.',
    vehicle: 'lrv', site: 'cape', date: '2026-10-18T06:00:00Z', weather: 'fair', countdownStart: 0, orbitAssist: false, recovery: false, start: 'moonSurface',
    objectives: [{ kind: 'lunarLiftoff', text: 'Lift off from the Moon' }, { kind: 'lunarOrbit', text: 'Reach lunar orbit' }, { kind: 'tei', text: 'Trans-Earth injection' }, { kind: 'survivedEntry', text: 'Survive entry' }, { kind: 'splashdown', text: 'Splashdown' }],
    tags: ['Moon', 'Reentry'], mood: 'hope',
  },
  {
    id: 'jupiter', number: 11, title: 'King of Planets', subtitle: 'Jupiter arrival',
    briefing: 'Six years out. The probe is falling toward Jupiter at forty kilometres per second relative to the planet. Plan the orbit insertion burn at closest approach, skim the cloud tops past the Great Red Spot and the Galilean moons, and stay.',
    vehicle: 'juno_probe', site: 'cape', date: '2026-10-07T00:00:00Z', weather: 'clear', countdownStart: 0, orbitAssist: false, recovery: false, start: 'jupiterApproach',
    objectives: [{ kind: 'jupiterSoi', text: 'Enter Jupiter\'s sphere of influence' }, { kind: 'perijove', text: 'Perijove below 300,000 km', param: 300_000_000 }, { kind: 'joi', text: 'Jupiter orbit insertion' }],
    tags: ['Jupiter', 'Deep space'], mood: 'wonder',
  },
];

export function getMission(id: string): MissionDef | undefined { return MISSIONS.find((m) => m.id === id); }
