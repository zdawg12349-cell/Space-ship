import type { EngineSpec } from './types';

/**
 * Engine library. Performance figures follow published data for the real engines each
 * class is modelled on (manufacturer data sheets, NASA/ESA fact sheets, Wikipedia
 * consolidations). Names are original; the comment lists the real-world analogue.
 */

const KN = 1000;

// SRB thrust-time shapes, multiplier vs burned propellant fraction
const SRB_SHUTTLE: [number, number][] = [[0, 1.06], [0.08, 1.0], [0.28, 0.74], [0.45, 0.8], [0.7, 0.86], [0.88, 0.62], [0.97, 0.22], [1, 0]];
const SRB_GEM: [number, number][] = [[0, 0.98], [0.3, 1.03], [0.65, 0.95], [0.88, 0.7], [0.97, 0.25], [1, 0]];
const SRB_PROGRESSIVE: [number, number][] = [[0, 0.88], [0.4, 1.04], [0.8, 1.0], [0.94, 0.55], [1, 0]];
const SRB_BOOST_SUSTAIN: [number, number][] = [[0, 1.12], [0.15, 1.08], [0.3, 0.86], [0.85, 0.82], [0.96, 0.3], [1, 0]];
const SRB_REGRESSIVE: [number, number][] = [[0, 1.25], [0.3, 1.15], [0.6, 0.9], [0.85, 0.7], [0.96, 0.4], [1, 0]];

export const ENGINES = {
  // --- small launcher (Rocket Lab Rutherford)
  ruth: { name: 'RF-25 "Wren"', thrustVac: 25.8 * KN, thrustSL: 24.9 * KN, ispVac: 343, ispSL: 311, minThrottle: 0.6, gimbal: 0.087, spoolUp: 1.2, restarts: 1, propellant: 'kerolox', plume: 'kerolox', exitRadius: 0.1, nozzleLength: 0.42, nozzle: 'regen' },
  ruthVac: { name: 'RF-25V "Wren Vac"', thrustVac: 25.8 * KN, thrustSL: 8 * KN, ispVac: 343, ispSL: 120, minThrottle: 0.6, gimbal: 0.087, spoolUp: 1.2, restarts: 3, propellant: 'kerolox', plume: 'kerolox', exitRadius: 0.22, nozzleLength: 0.9, nozzle: 'vacuum', radiativeExtension: true },
  curie: { name: 'KC-1 kick motor', thrustVac: 120, thrustSL: 40, ispVac: 300, ispSL: 100, minThrottle: 0, gimbal: 0, spoolUp: 0.3, restarts: 99, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.05, nozzleLength: 0.15, nozzle: 'ablative' },

  // --- SpaceX Merlin 1D / MVac class
  m1d: { name: 'KM-1 "Kestrel"', thrustVac: 914 * KN, thrustSL: 845 * KN, ispVac: 311, ispSL: 282, minThrottle: 0.4, gimbal: 0.087, spoolUp: 2.6, restarts: 4, propellant: 'kerolox', plume: 'kerolox', exitRadius: 0.46, nozzleLength: 1.1, nozzle: 'regen', nozzleTint: [0.22, 0.2, 0.19] },
  mvac: { name: 'KM-1V vacuum', thrustVac: 981 * KN, thrustSL: 420 * KN, ispVac: 348, ispSL: 150, minThrottle: 0.39, gimbal: 0.087, spoolUp: 2.2, restarts: 5, propellant: 'kerolox', plume: 'kerolox', exitRadius: 1.6, nozzleLength: 3.0, nozzle: 'vacuum', radiativeExtension: true },

  // --- RD-180 class (two chambers modelled as one mount with a twin-bell visual)
  rd180: { name: 'RK-180 twin-chamber', thrustVac: 4152 * KN, thrustSL: 3827 * KN, ispVac: 338, ispSL: 311, minThrottle: 0.47, gimbal: 0.14, spoolUp: 3.2, restarts: 1, propellant: 'kerolox', plume: 'kerolox', exitRadius: 0.75, nozzleLength: 2.6, nozzle: 'regen', nozzleTint: [0.3, 0.27, 0.24] },
  // --- RL10 class
  rl10: { name: 'HL-10C', thrustVac: 101.8 * KN, thrustSL: 30 * KN, ispVac: 449.7, ispSL: 200, minThrottle: 0.6, gimbal: 0.07, spoolUp: 2.0, restarts: 12, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 0.59, nozzleLength: 2.3, nozzle: 'vacuum', nozzleTint: [0.55, 0.52, 0.5] },
  rl10b2: { name: 'HL-10B extendible', thrustVac: 110 * KN, thrustSL: 25 * KN, ispVac: 465.5, ispSL: 190, minThrottle: 0.6, gimbal: 0.07, spoolUp: 2.0, restarts: 12, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 1.07, nozzleLength: 4.1, nozzle: 'vacuum', radiativeExtension: true },
  // --- RS-68A class
  rs68: { name: 'HR-68A', thrustVac: 3560 * KN, thrustSL: 3137 * KN, ispVac: 412, ispSL: 362, minThrottle: 0.55, gimbal: 0.105, spoolUp: 4.5, restarts: 1, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 1.22, nozzleLength: 3.2, nozzle: 'ablative', nozzleTint: [0.35, 0.3, 0.28] },
  // --- Raptor class
  raptor: { name: 'MR-2 "Raptor-class"', thrustVac: 2450 * KN, thrustSL: 2256 * KN, ispVac: 347, ispSL: 327, minThrottle: 0.4, gimbal: 0.26, spoolUp: 2.5, restarts: 6, propellant: 'methalox', plume: 'methalox', exitRadius: 0.65, nozzleLength: 1.6, nozzle: 'regen', nozzleTint: [0.62, 0.6, 0.58] },
  raptorFixed: { name: 'MR-2 fixed', thrustVac: 2450 * KN, thrustSL: 2256 * KN, ispVac: 347, ispSL: 327, minThrottle: 0.4, gimbal: 0, spoolUp: 2.5, restarts: 6, propellant: 'methalox', plume: 'methalox', exitRadius: 0.65, nozzleLength: 1.6, nozzle: 'regen', nozzleTint: [0.62, 0.6, 0.58] },
  raptorVac: { name: 'MR-2V vacuum', thrustVac: 2530 * KN, thrustSL: 1200 * KN, ispVac: 380, ispSL: 200, minThrottle: 0.4, gimbal: 0, spoolUp: 2.5, restarts: 6, propellant: 'methalox', plume: 'methalox', exitRadius: 1.15, nozzleLength: 3.0, nozzle: 'vacuum', radiativeExtension: true },
  // --- RD-107A / RD-108A (four-chamber, modelled as one mount)
  rd107: { name: 'RK-107 four-chamber', thrustVac: 1021 * KN, thrustSL: 838.5 * KN, ispVac: 320, ispSL: 263, minThrottle: 0, gimbal: 0.07, spoolUp: 3.0, restarts: 1, propellant: 'kerolox', plume: 'kerolox', exitRadius: 0.52, nozzleLength: 1.3, nozzle: 'regen' },
  rd108: { name: 'RK-108 four-chamber', thrustVac: 990 * KN, thrustSL: 792.5 * KN, ispVac: 319.5, ispSL: 257, minThrottle: 0, gimbal: 0.07, spoolUp: 3.0, restarts: 1, propellant: 'kerolox', plume: 'kerolox', exitRadius: 0.52, nozzleLength: 1.3, nozzle: 'regen' },
  rd0110: { name: 'RK-110 upper', thrustVac: 297.9 * KN, thrustSL: 150 * KN, ispVac: 325, ispSL: 200, minThrottle: 0, gimbal: 0.07, spoolUp: 2.0, restarts: 1, propellant: 'kerolox', plume: 'kerolox', exitRadius: 0.4, nozzleLength: 1.0, nozzle: 'regen' },
  soyuzSM: { name: 'SKD-class SM engine', thrustVac: 2.95 * KN, thrustSL: 1.5 * KN, ispVac: 305, ispSL: 150, minThrottle: 0, gimbal: 0, spoolUp: 0.5, restarts: 99, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.18, nozzleLength: 0.5, nozzle: 'ablative' },
  // --- Vulcain 2 / HM7B
  vulcain: { name: 'EV-2 "Vulcain-class"', thrustVac: 1390 * KN, thrustSL: 960 * KN, ispVac: 432, ispSL: 310, minThrottle: 0, gimbal: 0.105, spoolUp: 4.0, restarts: 1, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 1.05, nozzleLength: 2.9, nozzle: 'regen', nozzleTint: [0.4, 0.36, 0.33] },
  hm7: { name: 'EH-7B', thrustVac: 67 * KN, thrustSL: 20 * KN, ispVac: 446, ispSL: 200, minThrottle: 0, gimbal: 0.1, spoolUp: 2.0, restarts: 1, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 0.5, nozzleLength: 1.8, nozzle: 'vacuum' },
  p241: { name: 'P-240 segmented SRM', thrustVac: 6300 * KN, thrustSL: 5800 * KN, ispVac: 286, ispSL: 275, minThrottle: 0, gimbal: 0.1, spoolUp: 0.3, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 1.5, nozzleLength: 3.8, nozzle: 'srb', thrustCurve: SRB_BOOST_SUSTAIN },
  // --- Saturn V
  f1: { name: 'F-1 class "Titan"', thrustVac: 7740 * KN, thrustSL: 6770 * KN, ispVac: 304, ispSL: 263, minThrottle: 0, gimbal: 0.105, spoolUp: 4.5, restarts: 1, propellant: 'kerolox', plume: 'kerolox', exitRadius: 1.86, nozzleLength: 5.8, nozzle: 'regen', nozzleTint: [0.2, 0.19, 0.18] },
  f1Fixed: { name: 'F-1 class centre', thrustVac: 7740 * KN, thrustSL: 6770 * KN, ispVac: 304, ispSL: 263, minThrottle: 0, gimbal: 0, spoolUp: 4.5, restarts: 1, propellant: 'kerolox', plume: 'kerolox', exitRadius: 1.86, nozzleLength: 5.8, nozzle: 'regen', nozzleTint: [0.2, 0.19, 0.18] },
  j2: { name: 'J-2 class', thrustVac: 1033 * KN, thrustSL: 486 * KN, ispVac: 421, ispSL: 200, minThrottle: 0, gimbal: 0.122, spoolUp: 3.0, restarts: 2, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 1.0, nozzleLength: 3.4, nozzle: 'regen', nozzleTint: [0.25, 0.23, 0.22] },
  j2Fixed: { name: 'J-2 class centre', thrustVac: 1033 * KN, thrustSL: 486 * KN, ispVac: 421, ispSL: 200, minThrottle: 0, gimbal: 0, spoolUp: 3.0, restarts: 1, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 1.0, nozzleLength: 3.4, nozzle: 'regen', nozzleTint: [0.25, 0.23, 0.22] },
  sps: { name: 'SPS-class service engine', thrustVac: 91.2 * KN, thrustSL: 20 * KN, ispVac: 314, ispSL: 150, minThrottle: 0, gimbal: 0.105, spoolUp: 0.6, restarts: 50, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 1.25, nozzleLength: 2.9, nozzle: 'vacuum', radiativeExtension: true, nozzleTint: [0.75, 0.74, 0.72] },
  dps: { name: 'Descent engine (throttleable)', thrustVac: 45 * KN, thrustSL: 20 * KN, ispVac: 311, ispSL: 150, minThrottle: 0.1, gimbal: 0.105, spoolUp: 0.8, restarts: 20, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.75, nozzleLength: 1.5, nozzle: 'ablative' },
  aps: { name: 'Ascent engine', thrustVac: 16 * KN, thrustSL: 8 * KN, ispVac: 311, ispSL: 150, minThrottle: 0, gimbal: 0, spoolUp: 0.3, restarts: 30, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.4, nozzleLength: 0.8, nozzle: 'ablative' },
  lesMotor: { name: 'Escape motor', thrustVac: 650 * KN, thrustSL: 650 * KN, ispVac: 250, ispSL: 230, minThrottle: 0, gimbal: 0, spoolUp: 0.1, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 0.25, nozzleLength: 0.4, nozzle: 'srb', thrustCurve: [[0, 1], [0.9, 1], [1, 0]] },
  // --- PSLV
  s139: { name: 'S-139 solid core', thrustVac: 4100 * KN, thrustSL: 3800 * KN, ispVac: 269, ispSL: 237, minThrottle: 0, gimbal: 0.08, spoolUp: 0.3, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 1.1, nozzleLength: 2.8, nozzle: 'srb', thrustCurve: SRB_REGRESSIVE },
  psom: { name: 'PSOM-XL strap-on', thrustVac: 520 * KN, thrustSL: 470 * KN, ispVac: 262, ispSL: 240, minThrottle: 0, gimbal: 0, spoolUp: 0.3, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 0.48, nozzleLength: 1.4, nozzle: 'srb', thrustCurve: SRB_GEM },
  vikas: { name: 'VK-2 hypergolic', thrustVac: 799 * KN, thrustSL: 690 * KN, ispVac: 293, ispSL: 262, minThrottle: 0, gimbal: 0.07, spoolUp: 2.0, restarts: 1, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.72, nozzleLength: 1.9, nozzle: 'regen' },
  hps3: { name: 'HPS-3 solid', thrustVac: 240 * KN, thrustSL: 120 * KN, ispVac: 295, ispSL: 160, minThrottle: 0, gimbal: 0.035, spoolUp: 0.3, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 0.7, nozzleLength: 1.6, nozzle: 'srb', thrustCurve: SRB_PROGRESSIVE },
  ps4: { name: 'PS-4 twin', thrustVac: 15.2 * KN, thrustSL: 5 * KN, ispVac: 308, ispSL: 120, minThrottle: 0, gimbal: 0.05, spoolUp: 0.5, restarts: 8, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.22, nozzleLength: 0.6, nozzle: 'ablative' },
  // --- Long March 3B
  yf20: { name: 'YH-20 hypergolic', thrustVac: 816 * KN, thrustSL: 740 * KN, ispVac: 289, ispSL: 261, minThrottle: 0, gimbal: 0.17, spoolUp: 2.5, restarts: 1, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.5, nozzleLength: 1.4, nozzle: 'regen' },
  yf20b: { name: 'YH-20B booster', thrustVac: 816 * KN, thrustSL: 740 * KN, ispVac: 289, ispSL: 261, minThrottle: 0, gimbal: 0, spoolUp: 2.5, restarts: 1, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.5, nozzleLength: 1.4, nozzle: 'regen' },
  yf24: { name: 'YH-24E', thrustVac: 836 * KN, thrustSL: 300 * KN, ispVac: 300, ispSL: 150, minThrottle: 0, gimbal: 0.1, spoolUp: 2.5, restarts: 1, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.75, nozzleLength: 2.1, nozzle: 'regen' },
  yf75: { name: 'YH-75 cryogenic', thrustVac: 83.5 * KN, thrustSL: 25 * KN, ispVac: 442, ispSL: 200, minThrottle: 0, gimbal: 0.07, spoolUp: 2.0, restarts: 3, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 0.5, nozzleLength: 1.5, nozzle: 'vacuum' },
  // --- Delta II
  rs27: { name: 'RK-27A', thrustVac: 1054 * KN, thrustSL: 890 * KN, ispVac: 302, ispSL: 255, minThrottle: 0, gimbal: 0.14, spoolUp: 3.0, restarts: 1, propellant: 'kerolox', plume: 'kerolox', exitRadius: 0.83, nozzleLength: 1.9, nozzle: 'regen' },
  gem40: { name: 'GM-40 strap-on', thrustVac: 499 * KN, thrustSL: 446 * KN, ispVac: 274, ispSL: 245, minThrottle: 0, gimbal: 0, spoolUp: 0.3, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 0.4, nozzleLength: 1.0, nozzle: 'srb', thrustCurve: SRB_GEM },
  aj10: { name: 'AJ-118 hypergolic', thrustVac: 43.6 * KN, thrustSL: 15 * KN, ispVac: 319, ispSL: 150, minThrottle: 0, gimbal: 0.07, spoolUp: 0.6, restarts: 8, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.5, nozzleLength: 1.6, nozzle: 'vacuum', radiativeExtension: true },
  star48: { name: 'ST-48B kick motor', thrustVac: 66.7 * KN, thrustSL: 30 * KN, ispVac: 286, ispSL: 150, minThrottle: 0, gimbal: 0, spoolUp: 0.3, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 0.38, nozzleLength: 0.9, nozzle: 'srb', thrustCurve: [[0, 0.85], [0.5, 1.1], [0.9, 1.0], [1, 0]] },
  // --- Atlas V SRB
  aj60: { name: 'AJ-63 strap-on', thrustVac: 1380 * KN, thrustSL: 1330 * KN, ispVac: 279, ispSL: 260, minThrottle: 0, gimbal: 0, spoolUp: 0.3, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 0.62, nozzleLength: 1.6, nozzle: 'srb', thrustCurve: SRB_GEM },
  // --- SLS
  rs25: { name: 'HR-25 staged combustion', thrustVac: 2279 * KN, thrustSL: 1859 * KN, ispVac: 452, ispSL: 366, minThrottle: 0.67, gimbal: 0.17, spoolUp: 5.0, restarts: 1, propellant: 'hydrolox', plume: 'hydrolox', exitRadius: 1.15, nozzleLength: 3.1, nozzle: 'regen', nozzleTint: [0.32, 0.28, 0.24] },
  slsSrb: { name: 'FS-5 five-segment SRB', thrustVac: 16000 * KN, thrustSL: 14600 * KN, ispVac: 268, ispSL: 242, minThrottle: 0, gimbal: 0.087, spoolUp: 0.35, restarts: 1, propellant: 'solid', plume: 'solid', exitRadius: 1.9, nozzleLength: 4.5, nozzle: 'srb', thrustCurve: SRB_SHUTTLE },
  orionMain: { name: 'OMS-class main engine', thrustVac: 26.7 * KN, thrustSL: 10 * KN, ispVac: 316, ispSL: 150, minThrottle: 0, gimbal: 0.105, spoolUp: 0.5, restarts: 99, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.55, nozzleLength: 1.9, nozzle: 'vacuum', radiativeExtension: true },
  // --- Aerospike SSTO
  aerospike: { name: 'XA-9 annular aerospike', thrustVac: 5900 * KN, thrustSL: 5300 * KN, ispVac: 455, ispSL: 402, minThrottle: 0.3, gimbal: 0.1, spoolUp: 3.5, restarts: 4, propellant: 'hydrolox', plume: 'aerospike', exitRadius: 2.6, nozzleLength: 2.2, nozzle: 'aerospike' },
  // --- BE-4 class (methalox heavy)
  be4: { name: 'MB-4 "Glenn-class"', thrustVac: 2650 * KN, thrustSL: 2400 * KN, ispVac: 340, ispSL: 310, minThrottle: 0.4, gimbal: 0.1, spoolUp: 3.0, restarts: 4, propellant: 'methalox', plume: 'methalox', exitRadius: 0.75, nozzleLength: 2.0, nozzle: 'regen', nozzleTint: [0.4, 0.38, 0.36] },
  // --- Nuclear thermal (NERVA XE class)
  nerva: { name: 'NT-1 nuclear thermal', thrustVac: 334 * KN, thrustSL: 100 * KN, ispVac: 850, ispSL: 380, minThrottle: 0.3, gimbal: 0.05, spoolUp: 6.0, restarts: 20, propellant: 'nuclear', plume: 'nuclear', exitRadius: 1.0, nozzleLength: 3.2, nozzle: 'regen', nozzleTint: [0.5, 0.48, 0.45] },
  probeThruster: { name: 'Hydrazine trim thruster', thrustVac: 4.4 * KN, thrustSL: 2 * KN, ispVac: 230, ispSL: 120, minThrottle: 0, gimbal: 0, spoolUp: 0.2, restarts: 999, propellant: 'hypergolic', plume: 'hypergolic', exitRadius: 0.08, nozzleLength: 0.2, nozzle: 'ablative' },
} satisfies Record<string, EngineSpec>;

export type EngineKey = keyof typeof ENGINES;
