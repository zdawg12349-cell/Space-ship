import { ENGINES as E } from './engines';
import { asm, boosterRing, center, fairingHalves, offsetCopy, ring, Stack } from './build';
import type { AssemblyDef, VehicleDef } from './types';

/**
 * The launch-vehicle catalogue. Every vehicle is an original design whose dimensions,
 * masses, propulsion and staging follow a real vehicle class (listed in `analog`).
 * Values from public fact sheets; where stages were simplified the totals were kept.
 */

const deg = Math.PI / 180;

// =====================================================================================
// 1. SPARROW — small launcher (Electron class)
// =====================================================================================
function sparrow(): VehicleDef {
  const s1 = new Stack(0)
    .add('thrust', 1.0, 0.6, { material: 'black_carbon', mass: 120 })
    .add('tank', 11.0, 0.6, { material: 'black_carbon', mass: 600, propellant: 10600, raceway: true, label: 'SPARROW' })
    .add('interstage', 1.0, 0.6, { material: 'black_carbon', mass: 60 });
  const s2 = new Stack(s1.top)
    .add('tank', 2.4, 0.6, { material: 'black_carbon', mass: 150, propellant: 2600 })
    .add('interstage', 0.3, 0.6, { material: 'black_carbon', mass: 40, style: 'avionics' });
  const kick = new Stack(s2.top).add('kick', 0.45, 0.5, { material: 'aluminium', mass: 60, propellant: 40 });
  const pay = new Stack(kick.top).add('payload', 0.8, 0.38, { material: 'gold_foil', mass: 130, style: 'cubesat_bus' });
  return {
    id: 'sparrow', name: 'SPARROW', vehicleClass: 'Small launcher',
    tagline: 'Carbon-composite smallsat launcher with electric-pump engines',
    description: 'A nimble two-stage carbon composite rocket. Nine battery-driven pump-fed engines on the first stage, a single vacuum engine above and a tiny kick stage to circularise. Light, twitchy and fun to fly.',
    analog: 'Rocket Lab Electron', payloadLEO: 300, crewed: false,
    assemblies: [
      asm('core', 'First stage', null, s1.sections, [...center(E.ruth, 0.35), ...ring(E.ruth, 8, 0.4, 0.35)], { extraMass: 230, separation: { kind: 'stack', impulse: 1.2 }, maxSkinTemp: 900 }),
      asm('stage2', 'Second stage', 'core', s2.sections, center(E.ruthVac, 13.0), { extraMass: 50, features: { rcs: { thrust: 40, arm: 1.2 } }, separation: { kind: 'stack', impulse: 1.0 } }),
      asm('kick', 'Kick stage', 'stage2', kick.sections, center(E.curie, 15.7), { extraMass: 20, features: { rcs: { thrust: 10, arm: 0.5 }, reactionWheel: { torque: 30 } }, separation: { kind: 'stack', impulse: 0.8 } }),
      asm('payload', 'Smallsat', 'kick', pay.sections, [], { features: { solarPanels: { span: 1.8, y: 16.4, style: 'wings' }, reactionWheel: { torque: 2 } }, separation: { kind: 'payload', impulse: 0.6 } }),
      ...fairingHalves('stage2', 15.7, 2.5, 0.6, 50, { material: 'black_carbon' }),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['core'], label: 'Stage separation' }, { action: 'ignite', targets: ['stage2'], label: 'Second stage ignition' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['stage2'], label: 'Kick stage separation' }, { action: 'ignite', targets: ['kick'], label: 'Kick motor' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 2.5, clamps: 2,
    livery: { primary: [0.05, 0.05, 0.055], accent: [0.9, 0.9, 0.9], text: 'SPARROW' },
    targetOrbit: 220_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: false, reentry: false },
  };
}

// =====================================================================================
// 2. KESTREL 9 — reusable medium launcher (Falcon 9 Block 5 class)
// =====================================================================================
function kestrelFirstStage(id: string, name: string, parent: string | null, top: 'interstage' | 'nose', recovery: 'rtls' | 'droneship' | 'none'): AssemblyDef {
  const st = new Stack(0)
    .add('thrust', 2.5, 1.83, { material: 'soot', mass: 2400, style: 'octaweb' })
    .add('tank', 38.5, 1.83, { material: 'white_dirty', mass: 16300, propellant: 411000, raceway: true, frost: true, label: 'KESTREL' });
  if (top === 'interstage') st.add('interstage', 6.7, 1.83, { material: 'black_carbon', mass: 1800, style: 'gridfin_mount' });
  else st.add('nose', 6.0, 1.83, { material: 'black_carbon', mass: 650, shape: 'ogive' });
  return asm(id, name, parent, st.sections, [...center(E.m1d, 0.8, 'center'), ...ring(E.m1d, 8, 1.22, 0.8, 0, 'ring')], {
    extraMass: 4900,
    features: {
      gridFins: { y: top === 'interstage' ? 46.6 : 44.2, size: 1.25 },
      landingLegs: { y: 4.5, length: 9.6, count: 4 },
      rcs: { thrust: 2600, arm: 20 },
    },
    recovery,
    separation: { kind: 'stack', impulse: 1.6 },
    maxSkinTemp: 1250,
  });
}

function kestrelSecondStage(y0: number): { stage: AssemblyDef; top: number } {
  const st = new Stack(y0)
    .add('tank', 11.8, 1.83, { material: 'white', mass: 2600, propellant: 107500, raceway: true, frost: true })
    .add('interstage', 0.5, 1.83, { material: 'black_carbon', mass: 300, style: 'payload_adapter' });
  return {
    stage: asm('stage2', 'Second stage', 'core', st.sections, center(E.mvac, y0), { extraMass: 1000, features: { rcs: { thrust: 300, arm: 6 } }, separation: { kind: 'stack', impulse: 1.0 } }),
    top: st.top,
  };
}

function kestrel9(): VehicleDef {
  const core = kestrelFirstStage('core', 'First stage', null, 'interstage', 'rtls');
  const { stage, top } = kestrelSecondStage(47.7);
  const pay = new Stack(top).add('payload', 4.2, 1.5, { material: 'gold_foil', mass: 5200, style: 'comsat' });
  return {
    id: 'kestrel9', name: 'KESTREL 9', vehicleClass: 'Reusable launcher',
    tagline: 'Nine-engine kerosene workhorse that flies its first stage home',
    description: 'A two-stage kerosene/LOX launcher whose first stage flips around after separation, fires a boostback burn, steers through the atmosphere on titanium grid fins and lands on four carbon legs beside the launch site.',
    analog: 'SpaceX Falcon 9 Block 5', payloadLEO: 22800, crewed: false,
    assemblies: [
      core, stage,
      asm('payload', 'Communications satellite', 'stage2', pay.sections, [], { features: { solarPanels: { span: 22, y: top + 2, style: 'wings' }, reactionWheel: { torque: 40 } }, separation: { kind: 'payload', impulse: 0.5 } }),
      ...fairingHalves('stage2', top, 13.1, 2.6, 1900, { material: 'white' }),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['core'], label: 'Stage separation' }, { action: 'ignite', targets: ['stage2'], label: 'Second stage ignition' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 3.0, clamps: 4,
    livery: { primary: [0.92, 0.92, 0.92], accent: [0.08, 0.08, 0.1], text: 'KESTREL' },
    targetOrbit: 220_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: false, reentry: false },
  };
}

// =====================================================================================
// 3. MERIDIAN 421 — medium launcher (Atlas V 421 class)
// =====================================================================================
function atlasCore(): AssemblyDef {
  const st = new Stack(0)
    .add('thrust', 2.8, 1.905, { material: 'bronze', mass: 3000, style: 'atlas_boattail' })
    .add('tank', 29.7, 1.905, { material: 'bronze', mass: 13500, propellant: 284089, raceway: true, label: 'MERIDIAN' })
    .add('taper', 3.8, 1.905, { topRadius: 1.525, material: 'white', mass: 2100, style: 'isa' });
  return asm('core', 'Common core booster', null, st.sections, center({ ...E.rd180, name: E.rd180.name }, 1.6), { extraMass: 5480, separation: { kind: 'stack', impulse: 1.5, retro: 1 }, maxSkinTemp: 1100 });
}

function centaur(parent: string, y0: number, mass = 2320): { a: AssemblyDef; top: number } {
  const st = new Stack(y0).add('tank', 12.6, 1.525, { material: 'silver_foil', mass: mass - 520, propellant: 20830, style: 'centaur', frost: true });
  return { a: asm('centaur', 'Centaur-class upper stage', parent, st.sections, center(E.rl10, y0), { extraMass: 520, features: { rcs: { thrust: 120, arm: 6 } }, separation: { kind: 'stack', impulse: 0.9 } }), top: st.top };
}

function atlasSrb(): AssemblyDef {
  const st = new Stack(0.6)
    .add('srb', 18.4, 0.79, { material: 'white', mass: 4000, propellant: 42630 })
    .add('nose', 1.8, 0.79, { material: 'white', mass: 300, shape: 'cone' });
  return asm('srb', 'Solid booster', 'core', st.sections, [{ spec: E.aj60, pos: [0, 0.8, 0], cant: 3 * deg }], { ignitesAtLaunch: true, separation: { kind: 'radial', impulse: 4, spin: 0.18 }, maxSkinTemp: 1000 });
}

function meridian(): VehicleDef {
  const core = atlasCore();
  const { a: cen, top } = centaur('core', 36.3);
  const srb = atlasSrb();
  const srbs = [offsetCopy(srb, 'srb_1', 'Solid booster 1', [2.75, 0]), offsetCopy(srb, 'srb_2', 'Solid booster 2', [-2.75, 0])];
  const pay = new Stack(top).add('payload', 4.5, 1.6, { material: 'gold_foil', mass: 7600, style: 'comsat' });
  return {
    id: 'meridian', name: 'MERIDIAN 421', vehicleClass: 'Medium launcher',
    tagline: 'Twin-chamber kerosene core, strap-on solids and a hydrogen upper stage',
    description: 'A bronze-insulated common core powered by a twin-chamber staged-combustion engine, helped off the pad by two solid motors. The balloon-tank hydrogen upper stage is famously efficient and can relight a dozen times.',
    analog: 'ULA Atlas V 421', payloadLEO: 13300, crewed: false,
    assemblies: [core, ...srbs, cen,
      asm('payload', 'Satellite', 'centaur', pay.sections, [], { features: { solarPanels: { span: 18, y: top + 2, style: 'wings' }, reactionWheel: { torque: 30 } }, separation: { kind: 'payload', impulse: 0.5 } }),
      ...fairingHalves('centaur', top, 11.0, 2.1, 2100)],
    staging: [
      [{ action: 'ignite', targets: ['core', 'srb_1', 'srb_2'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['srb_1', 'srb_2'], label: 'Booster separation' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['core'], label: 'Stage separation' }, { action: 'ignite', targets: ['centaur'], label: 'Upper stage ignition' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 2.7, clamps: 4,
    livery: { primary: [0.62, 0.42, 0.25], accent: [0.95, 0.95, 0.95], text: 'MERIDIAN' },
    targetOrbit: 220_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: true, reentry: false },
  };
}

// =====================================================================================
// 4. AURORA HEAVY — heavy-lift (Delta IV Heavy class)
// =====================================================================================
function cbc(id: string, name: string, parent: string | null, nose: boolean): AssemblyDef {
  const st = new Stack(0)
    .add('thrust', 3.0, 2.55, { material: 'soot', mass: 4000, style: 'cbc_aft' })
    .add('tank', 36.0, 2.55, { material: 'orange_foam', mass: 15500, propellant: 202000, raceway: true, frost: true, label: nose ? undefined : 'AURORA' });
  if (nose) st.add('nose', 4.2, 2.55, { material: 'white', mass: 800, shape: 'ogive' });
  else st.add('interstage', 4.0, 2.55, { material: 'grey', mass: 1300 });
  return asm(id, name, parent, st.sections, center(E.rs68, 1.6), { extraMass: 6750, separation: nose ? { kind: 'radial', impulse: 3, spin: 0.06 } : { kind: 'stack', impulse: 1.5 }, maxSkinTemp: 1100 });
}

function auroraHeavy(): VehicleDef {
  const core = cbc('core', 'Centre core', null, false);
  core.coreThrottle = { from: 55, level: 0.58 };
  const left = offsetCopy(cbc('booster', 'Side booster', 'core', true), 'booster_l', 'Left booster', [5.2, 0], { ignitesAtLaunch: true });
  const right = offsetCopy(cbc('booster', 'Side booster', 'core', true), 'booster_r', 'Right booster', [-5.2, 0], { ignitesAtLaunch: true });
  const dc = new Stack(43.0).add('tank', 9.5, 2.55, { material: 'insulation_white', mass: 2900, propellant: 27220, frost: true });
  const pay = new Stack(dc.top).add('payload', 6.0, 2.0, { material: 'gold_foil', mass: 12000, style: 'spysat' });
  return {
    id: 'aurora_heavy', name: 'AURORA HEAVY', vehicleClass: 'Heavy-lift launcher',
    tagline: 'Three orange hydrogen cores lit in a towering fireball',
    description: 'Three common booster cores, each with a single huge hydrogen engine. At ignition, excess hydrogen ignites around the vehicle and scorches the orange foam black. The centre core throttles back early to burn long after the side boosters fall away.',
    analog: 'ULA Delta IV Heavy', payloadLEO: 28790, crewed: false,
    assemblies: [core, left, right,
      asm('dcss', 'Cryogenic upper stage', 'core', dc.sections, center(E.rl10b2, 43.0), { extraMass: 590, features: { rcs: { thrust: 200, arm: 6 } }, separation: { kind: 'stack', impulse: 1.0 } }),
      asm('payload', 'Reconnaissance satellite', 'dcss', pay.sections, [], { features: { solarPanels: { span: 24, y: dc.top + 3, style: 'wings' }, reactionWheel: { torque: 60 } }, separation: { kind: 'payload', impulse: 0.4 } }),
      ...fairingHalves('dcss', dc.top - 0.5, 19.1, 2.55, 3500)],
    staging: [
      [{ action: 'ignite', targets: ['core', 'booster_l', 'booster_r'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['booster_l', 'booster_r'], label: 'Booster separation' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['core'], label: 'Core separation' }, { action: 'ignite', targets: ['dcss'], label: 'Upper stage ignition' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 7.0, clamps: 6,
    livery: { primary: [0.85, 0.42, 0.12], accent: [0.95, 0.95, 0.95], text: 'AURORA' },
    targetOrbit: 250_000,
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: true, reentry: false },
  };
}

// =====================================================================================
// 5. LEVIATHAN — super-heavy, fully reusable (Starship / Super Heavy class)
// =====================================================================================
function leviathan(): VehicleDef {
  const b = new Stack(0)
    .add('thrust', 4.0, 4.5, { material: 'steel', mass: 30000, style: 'superheavy_aft' })
    .add('tank', 65.0, 4.5, { material: 'steel', mass: 110000, propellant: 3400000, stringers: false, frost: true, label: 'LEVIATHAN' })
    .add('interstage', 2.5, 4.5, { material: 'steel', mass: 9000, style: 'hotstage' });
  const engines = [
    ...ring(E.raptor, 3, 1.25, 1.6, 0, 'inner'),
    ...ring(E.raptor, 10, 2.65, 1.6, 0.31, 'middle'),
    ...ring(E.raptorFixed, 20, 3.85, 1.6, 0.15, 'outer'),
  ];
  for (const e of engines) if (e.group !== 'outer') e.roles = ['landing', 'boostback'];
  const s = new Stack(71.5)
    .add('thrust', 3.5, 4.5, { material: 'steel', mass: 12000, style: 'ship_aft' })
    .add('tank', 36.0, 4.5, { material: 'steel', mass: 55000, propellant: 1200000, frost: true })
    .add('nose', 10.5, 4.5, { material: 'steel', mass: 58000, shape: 'starship', style: 'ship_nose' });
  const shipEngines = [...ring(E.raptor, 3, 1.3, 72.6, 0, 'sl'), ...ring(E.raptorVac, 3, 3.05, 73.2, Math.PI / 3, 'vac')];
  return {
    id: 'leviathan', name: 'LEVIATHAN', vehicleClass: 'Super-heavy launcher',
    tagline: 'Thirty-three engines. Stainless steel. The largest thing ever to fly.',
    description: 'A two-stage, fully reusable methane rocket. The booster carries 33 engines and is caught back at the launch tower; the ship hot-stages by lighting its six engines while still attached. Liftoff thrust exceeds seventy meganewtons.',
    analog: 'SpaceX Starship / Super Heavy', payloadLEO: 150000, crewed: false,
    assemblies: [
      asm('core', 'Super-heavy booster', null, b.sections, engines, {
        extraMass: 52800,
        features: { gridFins: { y: 68.5, size: 2.6 }, rcs: { thrust: 12000, arm: 30 } },
        recovery: 'rtls', separation: { kind: 'stack', impulse: 1.4 }, maxSkinTemp: 1500,
      }),
      asm('ship', 'Ship', 'core', s.sections, shipEngines, { extraMass: 9600, features: { flaps: true, rcs: { thrust: 2500, arm: 22 } }, separation: { kind: 'stack', impulse: 1.0 }, maxSkinTemp: 1600 }),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'ignite', targets: ['ship'], label: 'Hot staging' }, { action: 'separate', targets: ['core'], label: 'Booster separation' }],
    ],
    ignitionLead: 3.5, clamps: 20,
    livery: { primary: [0.72, 0.72, 0.74], accent: [0.1, 0.1, 0.1], text: 'LEVIATHAN' },
    targetOrbit: 200_000,
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: true, reentry: false },
  };
}

// =====================================================================================
// 6. VOSTOK-R — crew launcher (Soyuz-2.1a / Soyuz MS class)
// =====================================================================================
function vostok(): VehicleDef {
  const core = new Stack(0)
    .add('thrust', 2.0, 1.03, { material: 'grey', mass: 1200, style: 'soyuz_tail' })
    .add('taper', 18.0, 1.03, { topRadius: 1.475, material: 'grey', mass: 2500, propellant: 70000, raceway: true })
    .add('tank', 7.0, 1.475, { material: 'grey', mass: 1500, propellant: 20100, frost: true, label: 'VOSTOK' })
    .add('interstage', 1.4, 1.33, { material: 'grey', mass: 600, style: 'truss' });
  const blk = new Stack(0)
    .add('taper', 19.6, 1.34, { topRadius: 0.32, material: 'grey', mass: 2600, propellant: 39160, frost: true, style: 'soyuz_booster' });
  const booster = asm('blk', 'Strap-on booster', 'core', blk.sections, [{ spec: E.rd107, pos: [0, 1.0, 0] }], {
    extraMass: 1190, ignitesAtLaunch: true, features: { finArea: 1.4 }, separation: { kind: 'radial', impulse: 3, spin: 0.85 }, maxSkinTemp: 1000,
  });
  const boosters = boosterRing(booster, 'blk_', 'Booster', 2.25, [0, 90, 180, 270]);
  const s3 = new Stack(28.4).add('tank', 6.7, 1.33, { material: 'grey', mass: 1700, propellant: 22890 });
  const sm = new Stack(s3.top).add('service', 2.3, 1.36, { material: 'green_soyuz', mass: 2020, propellant: 880, style: 'soyuz_sm' });
  const dm = new Stack(sm.top).add('capsule', 2.24, 1.085, { material: 'green_soyuz', mass: 2700, shape: 'soyuz' });
  const om = new Stack(dm.top).add('service', 2.2, 1.13, { material: 'green_soyuz', mass: 1300, style: 'soyuz_om' });
  return {
    id: 'vostok', name: 'VOSTOK-R', vehicleClass: 'Crew launcher',
    tagline: 'The proven crew rocket: four tapered boosters and the Korolev cross',
    description: 'A kerosene rocket built around a narrow-waisted core and four conical strap-ons that peel away in a perfect cross. On top rides a three-seat spacecraft with an escape tower; it returns under a single huge parachute and fires soft-landing rockets a metre above the steppe.',
    analog: 'Soyuz-2.1a with Soyuz MS', payloadLEO: 7080, crewed: true,
    assemblies: [
      asm('core', 'Core stage', null, core.sections, center(E.rd108, 1.0), { extraMass: 1300, separation: { kind: 'stack', impulse: 1.4 }, maxSkinTemp: 1000 }),
      ...boosters,
      asm('block_i', 'Third stage', 'core', s3.sections, center(E.rd0110, 28.4), { extraMass: 655, separation: { kind: 'stack', impulse: 1.2 } }),
      asm('sm', 'Service module', 'block_i', sm.sections, center(E.soyuzSM, s3.top), {
        extraMass: 0, features: { solarPanels: { span: 10.7, y: s3.top + 1.2, style: 'wings' }, rcs: { thrust: 130, arm: 3 } }, separation: { kind: 'stack', impulse: 0.8 },
      }),
      asm('dm', 'Descent module', 'sm', dm.sections, [], {
        features: {
          heatShield: { radius: 1.085, ablatorMass: 250, maxTemp: 2800, noseRadius: 2.2 },
          parachutes: { drogues: 1, drogueDiameter: 5.5, mains: 1, mainDiameter: 36, y: dm.top - 0.3 },
          retroRockets: { thrust: 140000, altitude: 1.2 }, crew: 3, rcs: { thrust: 100, arm: 1 }, reactionWheel: { torque: 400 },
        },
        separation: { kind: 'capsule', impulse: 0.6 },
      }),
      asm('om', 'Orbital module', 'dm', om.sections, [], { separation: { kind: 'stack', impulse: 0.8 } }),
      ...fairingHalves('block_i', s3.top, 9.3, 1.5, 3000, { material: 'white' }).map((f) => ({ ...f, separation: { kind: 'fairing' as const, impulse: 2.5, spin: 0.4 } })),
      asm('les', 'Escape tower', 'om', new Stack(s3.top + 9.3).add('les', 3.0, 0.42, { material: 'grey', mass: 1500, shape: 'cone' }).sections, [], { separation: { kind: 'les', impulse: 28 } }),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core', 'blk_1', 'blk_2', 'blk_3', 'blk_4'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'jettison', targets: ['les'], label: 'Escape tower jettison' }],
      [{ action: 'separate', targets: ['blk_1', 'blk_2', 'blk_3', 'blk_4'], label: 'Booster separation' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'ignite', targets: ['block_i'], label: 'Third stage ignition' }, { action: 'separate', targets: ['core'], label: 'Core separation' }],
      [{ action: 'separate', targets: ['sm'], label: 'Spacecraft separation' }, { action: 'ignite', targets: ['sm'], label: 'Service engine armed' }, { action: 'deploy_solar', targets: ['sm'], label: 'Solar arrays' }],
      [{ action: 'separate', targets: ['om', 'sm'], label: 'Module separation' }],
      [{ action: 'deploy_chutes', targets: ['dm'], label: 'Parachutes' }],
    ],
    ignitionLead: 6.0, clamps: 4,
    livery: { primary: [0.78, 0.8, 0.8], accent: [0.25, 0.36, 0.28], text: 'VOSTOK' },
    spacecraft: 'dm',
    targetOrbit: 210_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: false, reentry: true },
  };
}

// =====================================================================================
// 7. EUROPA 5 — cargo launcher (Ariane 5 ECA class)
// =====================================================================================
function europa5(): VehicleDef {
  const core = new Stack(0)
    .add('thrust', 2.5, 2.7, { material: 'insulation_white', mass: 2600, style: 'vulcain_aft' })
    .add('tank', 28.0, 2.7, { material: 'insulation_white', mass: 10000, propellant: 175000, frost: true, label: 'EUROPA' })
    .add('interstage', 1.8, 2.7, { material: 'grey', mass: 600 });
  const eap = new Stack(0)
    .add('srb', 27.6, 1.53, { material: 'white', mass: 31000, propellant: 240000, bands: 6 })
    .add('nose', 4.0, 1.53, { material: 'white', mass: 1000, shape: 'cone' });
  const booster = asm('eap', 'Solid booster', 'core', eap.sections, [{ spec: E.p241, pos: [0, 0.4, 0] }], { extraMass: 1000, ignitesAtLaunch: true, separation: { kind: 'radial', impulse: 4, spin: 0.12 } });
  const esc = new Stack(32.3).add('tank', 4.7, 2.7, { material: 'insulation_white', mass: 3500, propellant: 14900, frost: true });
  const pay = new Stack(esc.top).add('payload', 5.5, 2.2, { material: 'gold_foil', mass: 9000, style: 'comsat' });
  return {
    id: 'europa5', name: 'EUROPA 5', vehicleClass: 'Cargo launcher',
    tagline: 'Hydrogen core flanked by two colossal solid boosters',
    description: 'The geostationary freighter: a single hydrogen engine is lit and checked for seven seconds before two segmented solid boosters ignite and the vehicle leaves in a white-hot rush. Ideal for heavy satellites.',
    analog: 'Ariane 5 ECA', payloadLEO: 21000, crewed: false,
    assemblies: [
      asm('core', 'Cryogenic main stage', null, core.sections, center(E.vulcain, 1.5), { extraMass: 2100, separation: { kind: 'stack', impulse: 1.4 } }),
      offsetCopy(booster, 'eap_l', 'Left booster', [4.6, 0]), offsetCopy(booster, 'eap_r', 'Right booster', [-4.6, 0]),
      asm('esc', 'Cryogenic upper stage', 'core', esc.sections, center(E.hm7, 32.3), { extraMass: 1040, features: { rcs: { thrust: 120, arm: 3 } }, separation: { kind: 'stack', impulse: 1.0 } }),
      asm('payload', 'Telecom satellite', 'esc', pay.sections, [], { features: { solarPanels: { span: 30, y: esc.top + 3, style: 'wings' }, reactionWheel: { torque: 50 } }, separation: { kind: 'payload', impulse: 0.5 } }),
      ...fairingHalves('esc', esc.top, 17.0, 2.7, 2675),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core', 'eap_l', 'eap_r'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['eap_l', 'eap_r'], label: 'Booster separation' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['core'], label: 'Core separation' }, { action: 'ignite', targets: ['esc'], label: 'Upper stage ignition' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 7.0, clamps: 4,
    livery: { primary: [0.94, 0.93, 0.9], accent: [0.15, 0.2, 0.45], text: 'EUROPA' },
    targetOrbit: 250_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: false, reentry: false },
  };
}

// =====================================================================================
// 8. COLOSSUS V — lunar launcher (Saturn V / Apollo class)
// =====================================================================================
function apolloCSM(parent: string, y0: number, withLes: boolean, smProp = 18410): AssemblyDef[] {
  const sm = new Stack(y0).add('service', 4.9, 1.96, { material: 'aluminium', mass: 6110, propellant: smProp, style: 'apollo_sm' });
  const cm = new Stack(sm.top).add('capsule', 3.2, 1.96, { material: 'silver_foil', mass: 5000, shape: 'apollo' });
  const out: AssemblyDef[] = [
    asm('sm', 'Service module', parent, sm.sections, center(E.sps, y0), { features: { rcs: { thrust: 445, arm: 2 }, reactionWheel: { torque: 600 } }, separation: { kind: 'stack', impulse: 0.8 } }),
    asm('cm', 'Command module', 'sm', cm.sections, [], {
      features: {
        heatShield: { radius: 1.96, ablatorMass: 560, maxTemp: 3000, noseRadius: 4.69 },
        parachutes: { drogues: 2, drogueDiameter: 5.0, mains: 3, mainDiameter: 25.4, y: cm.top - 0.3 },
        crew: 3, rcs: { thrust: 410, arm: 1.6 }, reactionWheel: { torque: 900 },
      },
      separation: { kind: 'capsule', impulse: 0.5 },
    }),
  ];
  if (withLes) {
    const les = new Stack(cm.top - 3.2).add('fairing', 3.4, 2.05, { topRadius: 0.5, material: 'white', mass: 700, shape: 'cone', style: 'bpc' }).add('les', 7.4, 0.5, { topRadius: 0.25, material: 'grey', mass: 3500, style: 'apollo_les' });
    out.push(asm('les', 'Launch escape tower', 'cm', les.sections, [], { separation: { kind: 'les', impulse: 32 } }));
  }
  return out;
}

function colossus(): VehicleDef {
  const sic = new Stack(0)
    .add('thrust', 6.0, 5.05, { material: 'white', mass: 15000, style: 'saturn_aft' })
    .add('tank', 32.5, 5.05, { material: 'black_white_roll', mass: 70000, propellant: 2149500, stringers: true, frost: true, label: 'COLOSSUS' });
  const ring5 = new Stack(38.5).add('interstage', 5.5, 5.05, { material: 'white', mass: 5000, style: 'saturn_interstage' });
  const sii = new Stack(44.0)
    .add('tank', 24.9, 5.05, { material: 'white', mass: 30000, propellant: 451000, frost: true, bands: 2 })
    .add('taper', 4.2, 5.05, { topRadius: 3.3, material: 'white', mass: 3600 });
  const sivb = new Stack(73.1)
    .add('tank', 13.9, 3.3, { material: 'white', mass: 8000, propellant: 109000, frost: true, style: 'sivb' })
    .add('interstage', 0.9, 3.3, { material: 'grey', mass: 2000, style: 'iu' })
    .add('taper', 8.5, 3.3, { topRadius: 1.96, material: 'white', mass: 1800, style: 'sla' });
  const lm = new Stack(sivb.top - 7.6).add('lander', 6.4, 2.1, { material: 'gold_foil', mass: 15100, style: 'lm_folded' });
  const csm = apolloCSM('sivb', sivb.top, true);
  return {
    id: 'colossus', name: 'COLOSSUS V', vehicleClass: 'Lunar launcher',
    tagline: 'One hundred and ten metres. Seven and a half million pounds of thrust.',
    description: 'The three-stage moon rocket. Five enormous kerosene engines shake the coast for miles; five hydrogen engines carry it to the edge of space; a single restartable engine on the third stage puts the crew in orbit and then hurls them toward the Moon.',
    analog: 'Saturn V / Apollo CSM', payloadLEO: 140000, crewed: true,
    assemblies: [
      asm('sic', 'S-IC first stage', null, sic.sections, [...center(E.f1Fixed, 1.8), ...ring(E.f1, 4, 3.25, 1.8, Math.PI / 4)], { extraMass: 42000, features: { finArea: 28 }, separation: { kind: 'stack', impulse: 2.5, retro: 1 }, maxSkinTemp: 1100 }),
      asm('sii', 'S-II second stage', 'sic', sii.sections, [...center(E.j2Fixed, 44.0), ...ring(E.j2, 4, 2.65, 44.0, Math.PI / 4)], { extraMass: 8000, separation: { kind: 'stack', impulse: 1.6, retro: 1 } }),
      asm('sii_ring', 'S-II aft interstage', 'sii', ring5.sections, [], { separation: { kind: 'stack', impulse: 1.0 } }),
      asm('sivb', 'S-IVB third stage', 'sii', sivb.sections, center(E.j2, 73.1), { extraMass: 1600, features: { rcs: { thrust: 650, arm: 7 } }, separation: { kind: 'stack', impulse: 0.8 } }),
      asm('lm', 'Lunar module (stowed)', 'sivb', lm.sections, [], {}),
      ...csm,
    ],
    staging: [
      [{ action: 'ignite', targets: ['sic'], label: 'Ignition sequence' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['sic'], label: 'S-IC separation' }, { action: 'ignite', targets: ['sii'], label: 'S-II ignition' }],
      [{ action: 'jettison', targets: ['sii_ring'], label: 'Interstage jettison' }],
      [{ action: 'jettison', targets: ['les'], label: 'Escape tower jettison' }],
      [{ action: 'separate', targets: ['sii'], label: 'S-II separation' }, { action: 'ignite', targets: ['sivb'], label: 'S-IVB ignition' }],
      [{ action: 'separate', targets: ['sm'], label: 'CSM separation' }, { action: 'ignite', targets: ['sm'], label: 'Service engine armed' }],
      [{ action: 'separate', targets: ['sm'], label: 'SM jettison' }],
      [{ action: 'deploy_chutes', targets: ['cm'], label: 'Parachutes' }],
    ],
    ignitionLead: 8.9, clamps: 4,
    livery: { primary: [0.95, 0.95, 0.95], accent: [0.05, 0.05, 0.05], text: 'COLOSSUS' },
    spacecraft: 'cm',
    targetOrbit: 190_000,
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: true, reentry: true },
  };
}

// =====================================================================================
// 9. PATHFINDER — deep-space launcher (Atlas V 551 + Star 48B class)
// =====================================================================================
function pathfinder(): VehicleDef {
  const core = atlasCore();
  core.sections.find((s) => s.label)!.label = 'PATHFINDER';
  const srb = atlasSrb();
  const srbs = boosterRing(srb, 'srb_', 'Solid booster', 2.75, [30, 90, 150, 210, 270]);
  const { a: cen, top } = centaur('core', 36.3);
  const kick = new Stack(top).add('kick', 2.1, 0.62, { material: 'black_carbon', mass: 124, propellant: 2010, style: 'star48' });
  const probe = new Stack(kick.top).add('probe', 2.6, 1.05, { material: 'gold_foil', mass: 478, style: 'flyby_probe' });
  return {
    id: 'pathfinder', name: 'PATHFINDER', vehicleClass: 'Deep-space launcher',
    tagline: 'Five solids, a hydrogen stage and a spinning kick motor: escape velocity, fast',
    description: 'Built to throw a small probe out of the solar system faster than anything before it. Five strap-on solids, a Centaur-class upper stage and a spin-stabilised solid kick stage deliver a launch energy no other vehicle can match.',
    analog: 'Atlas V 551 + Star 48B (New Horizons)', payloadLEO: 18850, crewed: false,
    assemblies: [core, ...srbs, cen,
      asm('kick', 'Kick stage', 'centaur', kick.sections, center(E.star48, top), { separation: { kind: 'stack', impulse: 0.5, spin: 0 }, features: { reactionWheel: { torque: 50 } } }),
      asm('probe', 'Flyby probe', 'kick', probe.sections, [{ spec: E.probeThruster, pos: [0, kick.top, 0] }], { features: { rcs: { thrust: 20, arm: 1 }, reactionWheel: { torque: 8 } }, separation: { kind: 'payload', impulse: 0.4 } }),
      ...fairingHalves('centaur', top, 14.0, 2.7, 3500)],
    staging: [
      [{ action: 'ignite', targets: ['core', 'srb_1', 'srb_2', 'srb_3', 'srb_4', 'srb_5'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['srb_1', 'srb_2', 'srb_3', 'srb_4', 'srb_5'], label: 'Booster separation' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['core'], label: 'Stage separation' }, { action: 'ignite', targets: ['centaur'], label: 'Upper stage ignition' }],
      [{ action: 'separate', targets: ['centaur'], label: 'Kick stage separation' }, { action: 'ignite', targets: ['kick'], label: 'Kick motor ignition' }],
      [{ action: 'separate', targets: ['kick'], label: 'Probe separation' }, { action: 'ignite', targets: ['probe'], label: 'Probe thrusters' }],
    ],
    ignitionLead: 2.7, clamps: 4,
    livery: { primary: [0.62, 0.42, 0.25], accent: [0.95, 0.95, 0.95], text: 'PATHFINDER' },
    targetOrbit: 200_000,
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: true, reentry: false },
  };
}

// =====================================================================================
// 10. NOVA X — experimental SSTO with annular aerospike
// =====================================================================================
function nova(): VehicleDef {
  const st = new Stack(0)
    .add('thrust', 2.6, 3.2, { material: 'tiles', mass: 9000, style: 'aerospike_base' })
    .add('tank', 27.4, 3.2, { material: 'white', mass: 14000, propellant: 330000, frost: true, label: 'NOVA X' })
    .add('taper', 8.0, 3.2, { topRadius: 1.5, material: 'white', mass: 3000, propellant: 30000 });
  return {
    id: 'nova', name: 'NOVA X', vehicleClass: 'Experimental launcher',
    tagline: 'Single stage to orbit on an altitude-compensating aerospike',
    description: 'An experimental single-stage-to-orbit demonstrator. Its annular aerospike lets the exhaust shape itself to the air around it: a tight column at sea level, a broad bloom in vacuum. The margins are razor thin — fly it perfectly.',
    analog: 'Experimental SSTO (DC-Y / X-33 lineage)', payloadLEO: 6000, crewed: false,
    assemblies: [
      asm('core', 'SSTO vehicle', null, st.sections, [{ spec: E.aerospike, pos: [0, 1.6, 0] }], {
        extraMass: 4500,
        features: {
          landingLegs: { y: 3.0, length: 5.0, count: 4 }, rcs: { thrust: 1500, arm: 18 }, reactionWheel: { torque: 2000 }, finArea: 14,
          heatShield: { radius: 3.2, ablatorMass: 0, maxTemp: 1900, noseRadius: 4.0, reusable: true },
        },
        maxSkinTemp: 1500,
      }),
      asm('payload', 'Payload', 'core', new Stack(30.5).add('payload', 3.5, 1.3, { material: 'gold_foil', mass: 6000, style: 'comsat' }).sections, [], { features: { solarPanels: { span: 14, y: 32, style: 'wings' }, reactionWheel: { torque: 30 } }, separation: { kind: 'payload', impulse: 0.6 } }),
      ...fairingHalves('core', 38.0, 6.0, 1.5, 900, { material: 'tiles' }),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Nose doors' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
      [{ action: 'deploy_legs', targets: ['core'], label: 'Landing legs' }],
    ],
    ignitionLead: 3.5, clamps: 4,
    livery: { primary: [0.93, 0.93, 0.93], accent: [0.08, 0.08, 0.08], text: 'NOVA X' },
    targetOrbit: 160_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: false, reentry: false },
  };
}

// =====================================================================================
// 11. GARUDA — multi-stage (PSLV-XL class)
// =====================================================================================
function garuda(): VehicleDef {
  const ps1 = new Stack(0)
    .add('thrust', 2.0, 1.4, { material: 'grey', mass: 2000, style: 'ps1_aft' })
    .add('srb', 17.5, 1.4, { material: 'white', mass: 21000, propellant: 138000, bands: 5, label: 'GARUDA' })
    .add('interstage', 2.0, 1.4, { material: 'grey', mass: 1000 });
  const psom = new Stack(0)
    .add('srb', 12.0, 0.5, { material: 'white', mass: 2000, propellant: 12200, bands: 3 })
    .add('nose', 1.5, 0.5, { material: 'white', mass: 150, shape: 'cone' });
  const strap = asm('psom', 'Strap-on motor', 'ps1', psom.sections, [{ spec: E.psom, pos: [0, 0.6, 0] }], { extraMass: 350, separation: { kind: 'radial', impulse: 3.5, spin: 0.35 } });
  const straps = boosterRing(strap, 'psom_', 'Strap-on', 2.05, [0, 60, 120, 180, 240, 300], (i) => (i === 2 || i === 5 ? { airStart: 25 } : { ignitesAtLaunch: true }));
  const ps2 = new Stack(21.5)
    .add('tank', 12.8, 1.4, { material: 'white', mass: 3700, propellant: 42000 })
    .add('taper', 1.0, 1.4, { topRadius: 1.0, material: 'grey', mass: 300 });
  const ps3 = new Stack(ps2.top).add('srb', 3.6, 1.0, { material: 'black_carbon', mass: 1100, propellant: 7650 });
  const ps4 = new Stack(ps3.top).add('tank', 2.6, 0.67, { material: 'gold_foil', mass: 600, propellant: 2500, style: 'ps4' });
  const pay = new Stack(ps4.top).add('payload', 1.6, 0.6, { material: 'gold_foil', mass: 1500, style: 'eosat' });
  return {
    id: 'garuda', name: 'GARUDA XL', vehicleClass: 'Multi-stage launcher',
    tagline: 'Four stages, alternating solid and liquid, with six strap-ons',
    description: 'A remarkably versatile four-stage launcher: a giant solid first stage, a storable-propellant second stage, a carbon-cased solid third stage and a tiny restartable fourth stage. Two of its six strap-on motors are air-lit twenty-five seconds after liftoff.',
    analog: 'ISRO PSLV-XL', payloadLEO: 3800, crewed: false,
    assemblies: [
      asm('ps1', 'First stage (solid)', null, ps1.sections, center(E.s139, 1.0), { extraMass: 0, features: { rcs: { thrust: 4000, arm: 1.4 } }, separation: { kind: 'stack', impulse: 1.4 } }),
      ...straps,
      asm('ps2', 'Second stage (liquid)', 'ps1', ps2.sections, center(E.vikas, 21.5), { extraMass: 1300, separation: { kind: 'stack', impulse: 1.2 } }),
      asm('ps3', 'Third stage (solid)', 'ps2', ps3.sections, center(E.hps3, ps2.top), { separation: { kind: 'stack', impulse: 1.0 }, features: { rcs: { thrust: 200, arm: 2 } } }),
      asm('ps4', 'Fourth stage (liquid)', 'ps3', ps4.sections, ring(E.ps4, 2, 0.28, ps3.top), { extraMass: 320, features: { rcs: { thrust: 50, arm: 1 }, reactionWheel: { torque: 20 } }, separation: { kind: 'stack', impulse: 0.8 } }),
      asm('payload', 'Earth observation satellite', 'ps4', pay.sections, [], { features: { solarPanels: { span: 8, y: ps4.top + 0.8, style: 'wings' }, reactionWheel: { torque: 10 } }, separation: { kind: 'payload', impulse: 0.5 } }),
      ...fairingHalves('ps3', ps3.top - 0.4, 8.3, 1.6, 1150),
    ],
    staging: [
      [{ action: 'ignite', targets: ['ps1', 'psom_1', 'psom_2', 'psom_4', 'psom_5'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['psom_1', 'psom_2', 'psom_4', 'psom_5'], label: 'Ground-lit strap-on separation' }],
      [{ action: 'separate', targets: ['psom_3', 'psom_6'], label: 'Air-lit strap-on separation' }],
      [{ action: 'separate', targets: ['ps1'], label: 'First stage separation' }, { action: 'ignite', targets: ['ps2'], label: 'Second stage ignition' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['ps2'], label: 'Second stage separation' }, { action: 'ignite', targets: ['ps3'], label: 'Third stage ignition' }],
      [{ action: 'separate', targets: ['ps3'], label: 'Third stage separation' }, { action: 'ignite', targets: ['ps4'], label: 'Fourth stage ignition' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 0, clamps: 4,
    livery: { primary: [0.94, 0.94, 0.94], accent: [0.85, 0.35, 0.1], text: 'GARUDA' },
    targetOrbit: 500_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: false, reentry: false },
  };
}

// =====================================================================================
// 12. HYDRA — side-booster launcher (Long March 3B class, hypergolic)
// =====================================================================================
function hydra(): VehicleDef {
  const core = new Stack(0)
    .add('thrust', 3.0, 1.675, { material: 'white', mass: 1600, style: 'lm_aft' })
    .add('tank', 19.8, 1.675, { material: 'white', mass: 5800, propellant: 171800, label: 'HYDRA' })
    .add('interstage', 2.2, 1.675, { material: 'grey', mass: 600, style: 'truss' });
  const b = new Stack(0)
    .add('tank', 13.0, 1.125, { material: 'white', mass: 1800, propellant: 37700 })
    .add('nose', 2.3, 1.125, { material: 'white', mass: 150, shape: 'cone' });
  const booster = asm('hb', 'Liquid booster', 'core', b.sections, center(E.yf20b, 1.0), { extraMass: 1250, ignitesAtLaunch: true, features: { finArea: 3 }, separation: { kind: 'radial', impulse: 3, spin: 0.3 } });
  const boosters = boosterRing(booster, 'hb_', 'Booster', 2.95, [45, 135, 225, 315]);
  const s2 = new Stack(25.0)
    .add('tank', 9.9, 1.675, { material: 'white', mass: 2500, propellant: 49400 })
    .add('taper', 1.1, 1.675, { topRadius: 1.5, material: 'grey', mass: 400 });
  const s3 = new Stack(s2.top).add('tank', 12.4, 1.5, { material: 'white', mass: 2000, propellant: 18200, frost: true });
  const pay = new Stack(s3.top).add('payload', 4.0, 1.6, { material: 'gold_foil', mass: 5000, style: 'comsat' });
  return {
    id: 'hydra', name: 'HYDRA 3B', vehicleClass: 'Side-booster launcher',
    tagline: 'Four liquid strap-ons and a hydrogen third stage, wreathed in orange smoke',
    description: 'A storable-propellant workhorse with four finned liquid boosters. Its hypergolic engines need no igniters and leave a signature red-brown exhaust cloud drifting over the pad. A hydrogen third stage can relight for geostationary transfer.',
    analog: 'CASC Long March 3B', payloadLEO: 11200, crewed: false,
    assemblies: [
      asm('core', 'First stage', null, core.sections, ring(E.yf20, 4, 0.85, 1.5, Math.PI / 4), { extraMass: 2900, separation: { kind: 'stack', impulse: 1.3 } }),
      ...boosters,
      asm('stage2', 'Second stage', 'core', s2.sections, center(E.yf24, 25.0), { extraMass: 1500, separation: { kind: 'stack', impulse: 1.2 } }),
      asm('stage3', 'Cryogenic third stage', 'stage2', s3.sections, ring(E.yf75, 2, 0.55, s2.top), { extraMass: 800, features: { rcs: { thrust: 150, arm: 6 } }, separation: { kind: 'stack', impulse: 1.0 } }),
      asm('payload', 'Communications satellite', 'stage3', pay.sections, [], { features: { solarPanels: { span: 20, y: s3.top + 2, style: 'wings' }, reactionWheel: { torque: 40 } }, separation: { kind: 'payload', impulse: 0.5 } }),
      ...fairingHalves('stage3', s3.top - 0.6, 9.6, 2.0, 1500),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core', 'hb_1', 'hb_2', 'hb_3', 'hb_4'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['hb_1', 'hb_2', 'hb_3', 'hb_4'], label: 'Booster separation' }],
      [{ action: 'ignite', targets: ['stage2'], label: 'Second stage ignition' }, { action: 'separate', targets: ['core'], label: 'First stage separation' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['stage2'], label: 'Second stage separation' }, { action: 'ignite', targets: ['stage3'], label: 'Third stage ignition' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 3.0, clamps: 4,
    livery: { primary: [0.95, 0.95, 0.95], accent: [0.75, 0.1, 0.1], text: 'HYDRA' },
    targetOrbit: 200_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: false, reentry: false },
  };
}

// =====================================================================================
// 13. KESTREL HEAVY — heavy reusable (Falcon Heavy class)
// =====================================================================================
function kestrelHeavy(): VehicleDef {
  const core = kestrelFirstStage('core', 'Centre core', null, 'interstage', 'droneship');
  core.coreThrottle = { from: 50, level: 0.55 };
  const side = kestrelFirstStage('side', 'Side booster', 'core', 'nose', 'rtls');
  const left = offsetCopy(side, 'side_l', 'Side booster A', [3.98, 0], { ignitesAtLaunch: true, separation: { kind: 'radial', impulse: 2.2, spin: 0.08 } });
  const right = offsetCopy(side, 'side_r', 'Side booster B', [-3.98, 0], { ignitesAtLaunch: true, separation: { kind: 'radial', impulse: 2.2, spin: 0.08 } });
  const { stage, top } = kestrelSecondStage(47.7);
  const pay = new Stack(top).add('payload', 5.5, 2.0, { material: 'gold_foil', mass: 18000, style: 'spysat' });
  return {
    id: 'kestrel_heavy', name: 'KESTREL HEAVY', vehicleClass: 'Heavy reusable launcher',
    tagline: 'Twenty-seven engines. Two boosters landing side by side.',
    description: 'Three first-stage cores strapped together. The side boosters separate, boost back and touch down simultaneously at twin landing zones while the throttled-down centre core keeps climbing and lands far downrange on an ocean platform.',
    analog: 'SpaceX Falcon Heavy', payloadLEO: 63800, crewed: false,
    assemblies: [core, left, right, stage,
      asm('payload', 'Heavy satellite', 'stage2', pay.sections, [], { features: { solarPanels: { span: 26, y: top + 3, style: 'wings' }, reactionWheel: { torque: 80 } }, separation: { kind: 'payload', impulse: 0.4 } }),
      ...fairingHalves('stage2', top, 13.1, 2.6, 1900)],
    staging: [
      [{ action: 'ignite', targets: ['core', 'side_l', 'side_r'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['side_l', 'side_r'], label: 'Side booster separation' }],
      [{ action: 'separate', targets: ['core'], label: 'Core separation' }, { action: 'ignite', targets: ['stage2'], label: 'Second stage ignition' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 3.5, clamps: 8,
    livery: { primary: [0.92, 0.92, 0.92], accent: [0.08, 0.08, 0.1], text: 'KESTREL' },
    targetOrbit: 250_000,
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: true, reentry: false },
  };
}

// =====================================================================================
// 14. CORVID 7925 — satellite launcher (Delta II 7925 class, nine GEM strap-ons)
// =====================================================================================
function corvid(): VehicleDef {
  const core = new Stack(0)
    .add('thrust', 2.5, 1.22, { material: 'teal', mass: 1000, style: 'delta_aft' })
    .add('tank', 23.6, 1.22, { material: 'teal', mass: 3100, propellant: 96120, stringers: true, label: 'CORVID' })
    .add('interstage', 3.4, 1.22, { material: 'white', mass: 700 });
  const gem = new Stack(0.5)
    .add('srb', 11.0, 0.51, { material: 'white', mass: 1000, propellant: 11765, bands: 2 })
    .add('nose', 1.2, 0.51, { material: 'white', mass: 100, shape: 'cone' });
  const gemA = asm('gem', 'GM-40 strap-on', 'core', gem.sections, [{ spec: E.gem40, pos: [0, 0.8, 0], cant: 10 * deg }], { extraMass: 200, separation: { kind: 'radial', impulse: 3, spin: 0.4 } });
  const gems = boosterRing(gemA, 'gem_', 'Strap-on', 1.83, [0, 40, 80, 120, 160, 200, 240, 280, 320], (i) => ((i % 3) === 2 ? { airStart: 66 } : { ignitesAtLaunch: true }));
  const s2 = new Stack(29.5).add('tank', 5.9, 1.22, { material: 'white', mass: 700, propellant: 6004 });
  const s3 = new Stack(s2.top).add('kick', 2.0, 0.62, { material: 'black_carbon', mass: 124, propellant: 2010, style: 'star48' });
  const pay = new Stack(s3.top).add('payload', 1.8, 0.9, { material: 'gold_foil', mass: 1000, style: 'gps_sat' });
  const ground = ['gem_1', 'gem_2', 'gem_4', 'gem_5', 'gem_7', 'gem_8'];
  const air = ['gem_3', 'gem_6', 'gem_9'];
  return {
    id: 'corvid', name: 'CORVID 7925', vehicleClass: 'Satellite launcher',
    tagline: 'Nine slender strap-ons, six lit on the ground and three in the sky',
    description: 'A precise, dependable satellite launcher. Its teal first stage is ringed by nine thin solid motors with canted nozzles; three of them light in flight. A storable-propellant second stage and a spin-stabilised third stage deliver navigation satellites to exact orbits.',
    analog: 'Delta II 7925', payloadLEO: 6100, crewed: false,
    assemblies: [
      asm('core', 'First stage', null, core.sections, center(E.rs27, 1.0), { extraMass: 1180, separation: { kind: 'stack', impulse: 1.3 } }),
      ...gems,
      asm('stage2', 'Second stage', 'core', s2.sections, center(E.aj10, 29.5), { extraMass: 250, features: { rcs: { thrust: 60, arm: 3 } }, separation: { kind: 'stack', impulse: 1.0 } }),
      asm('stage3', 'Spin-stabilised third stage', 'stage2', s3.sections, center(E.star48, s2.top), { separation: { kind: 'stack', impulse: 0.6 }, features: { reactionWheel: { torque: 40 } } }),
      asm('payload', 'Navigation satellite', 'stage3', pay.sections, [], { features: { solarPanels: { span: 11, y: s3.top + 0.9, style: 'wings' }, reactionWheel: { torque: 10 } }, separation: { kind: 'payload', impulse: 0.5 } }),
      ...fairingHalves('stage2', s2.top - 0.4, 8.5, 1.45, 850),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core', ...ground], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ground, label: 'Ground-lit strap-on separation' }],
      [{ action: 'separate', targets: air, label: 'Air-lit strap-on separation' }],
      [{ action: 'separate', targets: ['core'], label: 'Stage separation' }, { action: 'ignite', targets: ['stage2'], label: 'Second stage ignition' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['stage2'], label: 'Third stage separation' }, { action: 'ignite', targets: ['stage3'], label: 'Third stage ignition' }],
      [{ action: 'separate', targets: ['payload'], label: 'Payload deploy' }, { action: 'deploy_solar', targets: ['payload'], label: 'Solar arrays' }],
    ],
    ignitionLead: 2.0, clamps: 4,
    livery: { primary: [0.2, 0.55, 0.58], accent: [0.95, 0.95, 0.95], text: 'CORVID' },
    targetOrbit: 400_000,
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: false, reentry: false },
  };
}

// =====================================================================================
// 15. ODYSSEY — advanced exploration / crew lunar (SLS Block 1 + Orion class)
// =====================================================================================
export function orionStack(parent: string, y0: number, withLas: boolean, esmProp = 8600): AssemblyDef[] {
  const esm = new Stack(y0).add('service', 4.0, 2.0, { material: 'silver_foil', mass: 6900, propellant: esmProp, style: 'orion_esm' });
  const cm = new Stack(esm.top).add('capsule', 3.3, 2.5, { material: 'silver_foil', mass: 9300, shape: 'orion' });
  const out: AssemblyDef[] = [
    asm('esm', 'European-style service module', parent, esm.sections, center(E.orionMain, y0), {
      features: { solarPanels: { span: 19, y: y0 + 3.4, style: 'cross' }, rcs: { thrust: 220, arm: 2.2 }, reactionWheel: { torque: 800 } },
      separation: { kind: 'stack', impulse: 0.8 },
    }),
    asm('cm', 'Crew module', 'esm', cm.sections, [], {
      features: {
        heatShield: { radius: 2.5, ablatorMass: 1100, maxTemp: 3200, noseRadius: 6.04 },
        parachutes: { drogues: 2, drogueDiameter: 7.0, mains: 3, mainDiameter: 35, y: cm.top - 0.3 },
        crew: 4, rcs: { thrust: 700, arm: 2 }, reactionWheel: { torque: 1500 },
      },
      separation: { kind: 'capsule', impulse: 0.5 },
    }),
  ];
  if (withLas) {
    const las = new Stack(esm.top).add('fairing', 5.4, 2.62, { topRadius: 0.7, material: 'white', mass: 3100, shape: 'ogive', style: 'orion_las' }).add('les', 7.6, 0.55, { topRadius: 0.25, material: 'white', mass: 4500, style: 'orion_tower' });
    out.push(asm('las', 'Launch abort system', 'cm', las.sections, [], { separation: { kind: 'les', impulse: 30 } }));
    const panels = new Stack(y0).add('fairing', 4.2, 2.62, { topRadius: 2.62, material: 'white', mass: 1200, style: 'esm_panels' });
    out.push(asm('esm_panels', 'SM fairing panels', 'esm', panels.sections, [], { separation: { kind: 'fairing', impulse: 3, spin: 0.6 } }));
  }
  return out;
}

function odyssey(): VehicleDef {
  const core = new Stack(0)
    .add('thrust', 6.0, 4.2, { material: 'orange_foam', mass: 12000, style: 'sls_engine_section' })
    .add('tank', 58.6, 4.2, { material: 'orange_foam', mass: 55000, propellant: 987000, stringers: true, frost: true, raceway: true, label: 'ODYSSEY' });
  const srb = new Stack(0)
    .add('thrust', 3.0, 2.3, { topRadius: 1.855, material: 'white', mass: 6000, style: 'srb_aft_skirt' })
    .add('srb', 47.0, 1.855, { material: 'white', mass: 85000, propellant: 631000, bands: 5, label: 'ODYSSEY' })
    .add('nose', 5.0, 1.855, { material: 'white', mass: 2000, shape: 'cone' });
  const srbA = asm('srb', 'Solid rocket booster', 'core', srb.sections, [{ spec: E.slsSrb, pos: [0, 0.6, 0] }], { extraMass: 6000, ignitesAtLaunch: true, separation: { kind: 'radial', impulse: 5, spin: 0.1 } });
  const lvsa = new Stack(64.6).add('taper', 8.4, 4.2, { topRadius: 2.55, material: 'white', mass: 4000, style: 'lvsa' });
  const icps = new Stack(73.0).add('tank', 13.7, 2.55, { material: 'white', mass: 2900, propellant: 27220, frost: true, style: 'icps' }).add('taper', 1.5, 2.55, { topRadius: 2.0, material: 'white', mass: 500 });
  return {
    id: 'odyssey', name: 'ODYSSEY', vehicleClass: 'Advanced exploration launcher',
    tagline: 'Four hydrogen main engines, two five-segment boosters, a crew bound for the Moon',
    description: 'A super heavy-lift crew launcher. Two five-segment solid boosters provide three quarters of the liftoff thrust, while four staged-combustion hydrogen engines burn for eight minutes. A cryogenic upper stage sends the four-seat crew capsule on its way to the Moon.',
    analog: 'NASA SLS Block 1 + Orion', payloadLEO: 95000, crewed: true,
    assemblies: [
      asm('core', 'Core stage', null, [...core.sections, ...lvsa.sections], ring(E.rs25, 4, 2.05, 2.6, Math.PI / 4), { extraMass: 18000, separation: { kind: 'stack', impulse: 1.4 }, maxSkinTemp: 1100 }),
      offsetCopy(srbA, 'srb_l', 'Left booster', [6.55, 0]), offsetCopy(srbA, 'srb_r', 'Right booster', [-6.55, 0]),
      asm('icps', 'Interim cryogenic stage', 'core', icps.sections, center(E.rl10b2, 73.0), { extraMass: 590, features: { rcs: { thrust: 180, arm: 6 } }, separation: { kind: 'stack', impulse: 1.0 } }),
      ...orionStack('icps', icps.top, true),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core', 'srb_l', 'srb_r'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['srb_l', 'srb_r'], label: 'Booster separation' }],
      [{ action: 'jettison', targets: ['esm_panels'], label: 'SM panel jettison' }, { action: 'jettison', targets: ['las'], label: 'Abort system jettison' }],
      [{ action: 'separate', targets: ['core'], label: 'Core stage separation' }, { action: 'ignite', targets: ['icps'], label: 'Upper stage ignition' }],
      [{ action: 'separate', targets: ['esm'], label: 'Spacecraft separation' }, { action: 'ignite', targets: ['esm'], label: 'Main engine armed' }, { action: 'deploy_solar', targets: ['esm'], label: 'Solar arrays' }],
      [{ action: 'separate', targets: ['esm'], label: 'Service module jettison' }],
      [{ action: 'deploy_chutes', targets: ['cm'], label: 'Parachutes' }],
    ],
    ignitionLead: 6.4, clamps: 8,
    livery: { primary: [0.85, 0.42, 0.12], accent: [0.95, 0.95, 0.95], text: 'ODYSSEY' },
    spacecraft: 'cm',
    targetOrbit: 185_000,
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: true, reentry: true },
  };
}

// =====================================================================================
// 16. PROMETHEUS — nuclear-thermal deep-space vehicle on a methane booster
// =====================================================================================
function prometheus(): VehicleDef {
  const b = new Stack(0)
    .add('thrust', 3.0, 3.5, { material: 'soot', mass: 6000, style: 'glenn_aft' })
    .add('tank', 47.0, 3.5, { material: 'white', mass: 62000, propellant: 1150000, frost: true, raceway: true, label: 'PROMETHEUS' })
    .add('interstage', 5.0, 3.5, { material: 'grey', mass: 3000 });
  const ntr = new Stack(55.0)
    .add('thrust', 3.0, 3.5, { material: 'grey', mass: 2000, style: 'shadow_shield' })
    .add('tank', 31.0, 3.5, { material: 'insulation_white', mass: 10000, propellant: 85000, frost: true, style: 'lh2_tank' });
  const probe = new Stack(ntr.top).add('probe', 5.0, 2.4, { material: 'gold_foil', mass: 4000, style: 'jupiter_probe' });
  return {
    id: 'prometheus', name: 'PROMETHEUS', vehicleClass: 'Advanced exploration launcher',
    tagline: 'A nuclear-thermal upper stage with twice the efficiency of any chemical rocket',
    description: 'A seven-engine methane booster lofts a hydrogen-fed nuclear-thermal upper stage. The reactor heats hydrogen to 2,500 K for a specific impulse of 850 seconds — enough to send a large probe straight to the outer planets.',
    analog: 'New Glenn-class booster + NERVA-class NTR', payloadLEO: 45000, crewed: false,
    assemblies: [
      asm('core', 'Methane booster', null, b.sections, [...center(E.be4, 1.5), ...ring(E.be4, 6, 2.3, 1.5)], { extraMass: 17500, features: { finArea: 16 }, separation: { kind: 'stack', impulse: 1.4 }, maxSkinTemp: 1100 }),
      asm('ntr', 'Nuclear thermal stage', 'core', ntr.sections, ring(E.nerva, 2, 1.25, 55.0), { extraMass: 10000, features: { rcs: { thrust: 450, arm: 15 }, reactionWheel: { torque: 400 } }, separation: { kind: 'stack', impulse: 0.8 } }),
      asm('probe', 'Outer-planet probe', 'ntr', probe.sections, [{ spec: E.probeThruster, pos: [0, ntr.top, 0] }], { features: { rcs: { thrust: 60, arm: 2 }, reactionWheel: { torque: 30 } }, separation: { kind: 'payload', impulse: 0.4 } }),
      ...fairingHalves('ntr', ntr.top - 0.5, 14.5, 3.6, 4000),
    ],
    staging: [
      [{ action: 'ignite', targets: ['core'], label: 'Ignition' }, { action: 'release', targets: [], label: 'Liftoff' }],
      [{ action: 'separate', targets: ['core'], label: 'Booster separation' }, { action: 'ignite', targets: ['ntr'], label: 'Reactor start' }],
      [{ action: 'jettison', targets: ['fairing_a', 'fairing_b'], label: 'Fairing jettison' }],
      [{ action: 'separate', targets: ['probe'], label: 'Probe separation' }, { action: 'ignite', targets: ['probe'], label: 'Probe thrusters' }],
    ],
    ignitionLead: 3.0, clamps: 6,
    livery: { primary: [0.94, 0.94, 0.94], accent: [0.2, 0.25, 0.5], text: 'PROMETHEUS' },
    targetOrbit: 250_000,
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: true, reentry: false },
  };
}

// =====================================================================================
// Mission spacecraft (start in space)
// =====================================================================================
function aquila(withTli: boolean): VehicleDef {
  const tli = new Stack(0).add('tank', 9.0, 2.55, { material: 'insulation_white', mass: 2600, propellant: 25000, frost: true, style: 'icps' }).add('taper', 1.2, 2.55, { topRadius: 2.0, material: 'white', mass: 400 });
  const asms: AssemblyDef[] = [];
  if (withTli) asms.push(asm('tli', 'Trans-lunar stage', null, tli.sections, center(E.rl10b2, 0), { extraMass: 600, features: { rcs: { thrust: 180, arm: 5 } }, separation: { kind: 'stack', impulse: 1.0 } }));
  const stack = orionStack(withTli ? 'tli' : (null as unknown as string), withTli ? tli.top : 0, false);
  if (!withTli) stack[0].parent = null;
  asms.push(...stack);
  for (const a of asms) if (a.id === 'esm') { /* solar arrays deployed at mission start */ }
  return {
    id: withTli ? 'aquila_tli' : 'aquila', name: withTli ? 'AQUILA + TLI STAGE' : 'AQUILA', vehicleClass: 'Crew launcher',
    tagline: 'Four-seat deep-space crew capsule', description: 'Crew module with heat shield and parachutes on a solar-powered service module.',
    analog: 'Orion-class spacecraft', payloadLEO: 0, crewed: true,
    assemblies: asms,
    staging: withTli
      ? [[{ action: 'separate', targets: ['tli'], label: 'TLI stage separation' }, { action: 'ignite', targets: ['esm'], label: 'Main engine armed' }], [{ action: 'separate', targets: ['esm'], label: 'Service module jettison' }], [{ action: 'deploy_chutes', targets: ['cm'], label: 'Parachutes' }]]
      : [[{ action: 'separate', targets: ['esm'], label: 'Service module jettison' }], [{ action: 'deploy_chutes', targets: ['cm'], label: 'Parachutes' }]],
    ignitionLead: 0, clamps: 0,
    livery: { primary: [0.9, 0.9, 0.9], accent: [0.2, 0.2, 0.2], text: 'AQUILA' },
    spacecraft: 'cm',
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: false, reentry: true },
  };
}

function seleneLander(): VehicleDef {
  const desc = new Stack(0).add('lander', 3.2, 2.1, { material: 'gold_foil', mass: 2034, propellant: 8248, style: 'lm_descent' });
  const ascent = new Stack(desc.top).add('lander', 2.9, 1.7, { material: 'silver_foil', mass: 2150, propellant: 2353, style: 'lm_ascent' });
  return {
    id: 'selene', name: 'SELENE LANDER', vehicleClass: 'Lunar launcher',
    tagline: 'Two-stage lunar module', description: 'A throttleable descent stage with four legs and an ascent stage that lifts off using the descent stage as a launch pad.',
    analog: 'Apollo Lunar Module', payloadLEO: 0, crewed: true,
    assemblies: [
      asm('descent', 'Descent stage', null, desc.sections, center(E.dps, 0.2), { features: { landingLegs: { y: 2.6, length: 3.4, count: 4 }, legsLunar: true }, separation: { kind: 'lander', impulse: 0.5 } }),
      asm('ascent', 'Ascent stage', 'descent', ascent.sections, center(E.aps, desc.top), { features: { rcs: { thrust: 445, arm: 1.6 }, reactionWheel: { torque: 400 }, crew: 2 }, separation: { kind: 'lander', impulse: 0.5 } }),
    ],
    staging: [
      [{ action: 'deploy_legs', targets: ['descent'], label: 'Landing legs' }, { action: 'ignite', targets: ['descent'], label: 'Descent engine armed' }],
      [{ action: 'separate', targets: ['descent'], label: 'Ascent stage liftoff' }, { action: 'ignite', targets: ['ascent'], label: 'Ascent engine' }],
    ],
    ignitionLead: 0, clamps: 0,
    livery: { primary: [0.85, 0.7, 0.3], accent: [0.2, 0.2, 0.2], text: 'SELENE' },
    spacecraft: 'ascent',
    capabilities: { orbit: true, moon: true, moonLanding: true, deepSpace: false, reentry: false },
  };
}

function lunarReturnVehicle(): VehicleDef {
  const base = new Stack(0).add('lander', 2.4, 2.4, { material: 'gold_foil', mass: 1800, propellant: 0, style: 'lrv_base' });
  // ~3.2 km/s: lunar ascent (~1.9 km/s with losses) and trans-Earth injection (~0.95) with a margin
  const stage = new Stack(base.top).add('service', 3.6, 1.9, { material: 'silver_foil', mass: 2100, propellant: 10400, style: 'lrv_stage' });
  const cm = new Stack(stage.top).add('capsule', 2.6, 1.9, { material: 'silver_foil', mass: 3600, shape: 'apollo' });
  return {
    id: 'lrv', name: 'HORIZON RETURN VEHICLE', vehicleClass: 'Lunar launcher',
    tagline: 'Direct-return ascent vehicle', description: 'A landing platform, a hypergolic ascent/return stage and a three-seat capsule able to fly straight from the lunar surface back to Earth.',
    analog: 'Direct-ascent lunar return concept', payloadLEO: 0, crewed: true,
    assemblies: [
      asm('base', 'Landing platform', null, base.sections, [], { features: { landingLegs: { y: 2.0, length: 3.4, count: 4 }, legsLunar: true }, separation: { kind: 'lander', impulse: 0.3 } }),
      asm('ascent', 'Ascent & return stage', 'base', stage.sections, center({ ...E.dps, name: 'Ascent & return engine (throttleable)', restarts: 20 }, base.top), { features: { rcs: { thrust: 400, arm: 2 }, reactionWheel: { torque: 600 } }, separation: { kind: 'stack', impulse: 0.8 } }),
      asm('cm', 'Return capsule', 'ascent', cm.sections, [], {
        features: {
          heatShield: { radius: 1.9, ablatorMass: 450, maxTemp: 3000, noseRadius: 4.5 },
          parachutes: { drogues: 2, drogueDiameter: 5, mains: 3, mainDiameter: 24, y: cm.top - 0.3 },
          crew: 3, rcs: { thrust: 400, arm: 1.5 }, reactionWheel: { torque: 900 },
        },
        separation: { kind: 'capsule', impulse: 0.5 },
      }),
    ],
    staging: [
      [{ action: 'separate', targets: ['base'], label: 'Lunar liftoff' }, { action: 'ignite', targets: ['ascent'], label: 'Ascent engine' }],
      [{ action: 'separate', targets: ['ascent'], label: 'Stage jettison' }],
      [{ action: 'deploy_chutes', targets: ['cm'], label: 'Parachutes' }],
    ],
    ignitionLead: 0, clamps: 0,
    livery: { primary: [0.9, 0.9, 0.9], accent: [0.2, 0.2, 0.2], text: 'HORIZON' },
    spacecraft: 'cm',
    capabilities: { orbit: true, moon: true, moonLanding: false, deepSpace: false, reentry: true },
  };
}

function jupiterProbe(): VehicleDef {
  const bus = new Stack(0).add('probe', 3.5, 1.8, { material: 'gold_foil', mass: 1600, propellant: 900, style: 'jupiter_probe' });
  return {
    id: 'juno_probe', name: 'ARGO PROBE', vehicleClass: 'Deep-space launcher',
    tagline: 'Outer-planet flyby probe', description: 'A solar-powered probe with a high-gain antenna and a small bipropellant engine for trajectory corrections.',
    analog: 'Juno / Galileo-class probe', payloadLEO: 0, crewed: false,
    assemblies: [asm('probe', 'Probe', null, bus.sections, [{ spec: { ...E.probeThruster, thrustVac: 645, thrustSL: 300, ispVac: 317 }, pos: [0, 0, 0] }], { features: { solarPanels: { span: 20, y: 1.5, style: 'cross' }, rcs: { thrust: 40, arm: 2 }, reactionWheel: { torque: 40 } } })],
    staging: [[{ action: 'ignite', targets: ['probe'], label: 'Main engine armed' }]],
    ignitionLead: 0, clamps: 0,
    livery: { primary: [0.85, 0.7, 0.3], accent: [0.2, 0.2, 0.2], text: 'ARGO' },
    capabilities: { orbit: true, moon: false, moonLanding: false, deepSpace: true, reentry: false },
  };
}

// =====================================================================================

export const LAUNCHERS: VehicleDef[] = [
  sparrow(), kestrel9(), meridian(), auroraHeavy(), leviathan(), vostok(), europa5(), colossus(),
  pathfinder(), nova(), garuda(), hydra(), kestrelHeavy(), corvid(), odyssey(), prometheus(),
];

export const SPACECRAFT: VehicleDef[] = [aquila(false), aquila(true), seleneLander(), lunarReturnVehicle(), jupiterProbe()];

export const ALL_VEHICLES: VehicleDef[] = [...LAUNCHERS, ...SPACECRAFT];

export function getVehicle(id: string): VehicleDef {
  const v = ALL_VEHICLES.find((x) => x.id === id);
  if (!v) throw new Error(`Unknown vehicle ${id}`);
  // deep clone so runtime mutation never leaks into the catalogue
  return structuredClone(v);
}

/** Summary numbers computed from the definition (liftoff mass, thrust, height). */
export function vehicleStats(def: VehicleDef): { mass: number; thrustSL: number; height: number; width: number; stages: number } {
  let mass = 0, thrust = 0, top = 0, bottom = 0, width = 0;
  const lit = new Set<string>();
  for (const ev of def.staging[0] ?? []) if (ev.action === 'ignite') ev.targets.forEach((t) => lit.add(t));
  for (const a of def.assemblies) {
    mass += a.extraMass ?? 0;
    for (const s of a.sections) {
      mass += s.mass + (s.propellant ?? 0);
      top = Math.max(top, s.y + s.length);
      bottom = Math.min(bottom, s.y);
      const lateral = a.offset ? Math.hypot(a.offset[0], a.offset[1]) : 0;
      width = Math.max(width, 2 * (lateral + Math.max(s.radius, s.topRadius ?? 0)));
    }
    if (lit.has(a.id)) for (const e of a.engines) thrust += e.spec.thrustSL;
  }
  const stages = def.staging.filter((g) => g.some((e) => e.action === 'ignite')).length;
  return { mass, thrustSL: thrust, height: top - bottom, width, stages };
}
