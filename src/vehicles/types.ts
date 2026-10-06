/**
 * Data model for launch vehicles. A vehicle is a set of assemblies (stages, boosters,
 * fairings, spacecraft) that are rigid until a staging event separates them. The same
 * description drives physics (mass, propulsion, aerodynamics) and the procedural 3D builder.
 *
 * Vehicle frame: +Y is the long axis (nose up), metres. y = 0 is the base of the first-stage
 * thrust section; nozzles hang below. X/Z are lateral. Side boosters carry a radial offset.
 */

export type PropellantKind = 'kerolox' | 'hydrolox' | 'methalox' | 'hypergolic' | 'solid' | 'nuclear' | 'xenon';

export type PlumeStyle =
  | 'kerolox' // orange/yellow, sooty, bright core
  | 'hydrolox' // nearly transparent, blue-violet core, strong Mach diamonds
  | 'methalox' // blue core with orange fringe, clean
  | 'hypergolic' // pale orange-pink, translucent, red-brown smoke
  | 'solid' // brilliant white/yellow, dense white smoke
  | 'nuclear' // faint blue-white hydrogen
  | 'aerospike';

export interface EngineSpec {
  name: string;
  thrustVac: number; // N
  thrustSL: number; // N (vacuum-optimised engines may be ~0 or reduced)
  ispVac: number; // s
  ispSL: number; // s
  minThrottle: number; // fraction (0 => not throttleable, fixed 1)
  gimbal: number; // rad
  spoolUp: number; // s from ignition command to full thrust
  restarts: number; // ignitions available (incl. first)
  propellant: PropellantKind;
  plume: PlumeStyle;
  exitRadius: number; // nozzle exit radius, m
  nozzleLength: number; // m
  throatRadius?: number;
  /** solid motors: thrust multiplier vs burned fraction */
  thrustCurve?: [number, number][];
  /** visual nozzle type */
  nozzle?: 'regen' | 'vacuum' | 'srb' | 'aerospike' | 'ablative';
  /** dark radiatively cooled extension that glows when hot */
  radiativeExtension?: boolean;
  /** tea-staining / colour of the nozzle metal */
  nozzleTint?: [number, number, number];
}

export interface EngineMount {
  spec: EngineSpec;
  /** position of the gimbal point (top of nozzle) in vehicle frame */
  pos: [number, number, number];
  /** extra cant (rad) outward from the axis for clustered boosters */
  cant?: number;
  /** engine belongs to a cluster which is lit together; used for engine-out & landing burns */
  group?: string;
  /** engine used for landing burns / boostback (reusable boosters) */
  roles?: ('landing' | 'boostback' | 'entry')[];
}

export type MaterialStyle =
  | 'white' | 'white_dirty' | 'black_carbon' | 'steel' | 'orange_foam' | 'aluminium'
  | 'grey' | 'gold_foil' | 'silver_foil' | 'cork' | 'soot' | 'insulation_white' | 'green_soyuz' | 'black_white_roll'
  | 'teal' | 'bronze' | 'tiles';

export type SectionKind =
  | 'tank' // cylindrical tank with domes
  | 'taper' // conical adapter
  | 'interstage'
  | 'thrust' // aft engine section / skirt
  | 'nose' // ogive / cone nose
  | 'fairing' // payload fairing (2 halves) — owned by a fairing assembly
  | 'capsule'
  | 'service' // service module
  | 'lander'
  | 'payload'
  | 'les' // launch escape tower
  | 'srb' // solid booster casing (cylinder with segments)
  | 'ship' // starship-like upper stage with flaps
  | 'probe' // deep space probe
  | 'kick'; // spin-stabilised kick motor

export interface SectionDef {
  kind: SectionKind;
  /** base y of this section (vehicle frame) */
  y: number;
  length: number;
  radius: number; // base radius
  topRadius?: number; // for tapers / nose shapes
  material: MaterialStyle;
  /** dry structural mass of this section (kg) */
  mass: number;
  /** propellant tank capacity (kg) if this section stores propellant */
  propellant?: number;
  label?: string; // painted text (vehicle name, flags)
  /** visual detail toggles */
  stringers?: boolean;
  raceway?: boolean;
  frost?: boolean; // cryogenic frost coat on the pad
  bands?: number; // decorative rings
  shape?: 'ogive' | 'cone' | 'blunt' | 'apollo' | 'soyuz' | 'orion' | 'dragon' | 'shuttle' | 'starship';
  style?: string; // builder-specific variant
}

export type SeparationKind = 'stack' | 'radial' | 'fairing' | 'les' | 'capsule' | 'payload' | 'lander';

export interface AssemblyDef {
  id: string;
  name: string;
  parent: string | null;
  /** lateral position of the assembly's axis (side boosters), vehicle frame */
  offset?: [number, number];
  sections: SectionDef[];
  engines: EngineMount[];
  /** extra dry mass not in sections (avionics, engines' mass is included here) */
  extraMass?: number;
  separation?: { kind: SeparationKind; impulse: number; spin?: number; retro?: number };
  features?: {
    gridFins?: { y: number; size: number };
    landingLegs?: { y: number; length: number; count: number };
    heatShield?: { radius: number; ablatorMass: number; maxTemp: number; noseRadius: number; reusable?: boolean };
    parachutes?: { drogues: number; drogueDiameter: number; mains: number; mainDiameter: number; y: number };
    rcs?: { thrust: number; arm: number };
    reactionWheel?: { torque: number };
    solarPanels?: { span: number; y: number; style: 'wings' | 'cross' | 'circular' };
    retroRockets?: { thrust: number; altitude: number }; // Soyuz soft-landing
    crew?: number;
    finArea?: number; // aerodynamic fins (m^2, total)
    flaps?: boolean; // starship-like flaps
    legsLunar?: boolean;
    les?: { thrust: number; burn: number };
  };
  recovery?: 'rtls' | 'droneship' | 'none';
  /** lit at liftoff (side boosters, SRBs) */
  ignitesAtLaunch?: boolean;
  /** air-started strap-on: flight software ignites it this many seconds after liftoff */
  airStart?: number;
  /** flight software throttle-down (heavy centre cores): [startTime, endEvent, level] */
  coreThrottle?: { from: number; level: number };
  /** maximum heat tolerance of skin (K) */
  maxSkinTemp?: number;
}

export interface StageEvent {
  action: 'ignite' | 'separate' | 'jettison' | 'deploy_chutes' | 'deploy_legs' | 'deploy_solar' | 'shutdown' | 'release';
  targets: string[]; // assembly ids (or 'all')
  label: string; // shown in the staging list
}

export type VehicleClass =
  | 'Small launcher' | 'Medium launcher' | 'Heavy-lift launcher' | 'Super-heavy launcher' | 'Reusable launcher'
  | 'Crew launcher' | 'Cargo launcher' | 'Lunar launcher' | 'Deep-space launcher' | 'Experimental launcher'
  | 'Multi-stage launcher' | 'Side-booster launcher' | 'Heavy reusable launcher' | 'Satellite launcher'
  | 'Advanced exploration launcher';

export interface VehicleDef {
  id: string;
  name: string;
  vehicleClass: VehicleClass;
  tagline: string;
  description: string;
  analog: string; // real-world comparison, informational
  payloadLEO: number; // kg
  crewed: boolean;
  assemblies: AssemblyDef[];
  /** staging sequence; each entry fires when the player stages */
  staging: StageEvent[][];
  /** countdown: seconds before T-0 at which liquid engines are commanded to ignite */
  ignitionLead: number;
  /** liftoff hold-down clamps */
  clamps: number;
  /** colour accents for the procedural livery */
  livery: { primary: [number, number, number]; accent: [number, number, number]; text: string; flag?: string };
  /** which assembly is the "spacecraft" for reentry missions */
  spacecraft?: string;
  /** default target orbit for orbit assist (m altitude) */
  targetOrbit?: number;
  capabilities: { orbit: boolean; moon: boolean; moonLanding: boolean; deepSpace: boolean; reentry: boolean };
}
