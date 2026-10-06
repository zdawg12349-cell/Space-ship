/**
 * Atmosphere models. Earth uses the U.S. Standard Atmosphere 1976 (0–86 km exact layer
 * equations, 86–1000 km tabulated density from the same standard, log-interpolated).
 */

export interface AtmosphereSample {
  pressure: number; // Pa
  density: number; // kg/m^3
  temperature: number; // K
  speedOfSound: number; // m/s
}

export interface AtmosphereModel {
  readonly top: number; // m, altitude above which density is treated as zero
  /** practical edge of the atmosphere (drag negligible on mission timescales) — used for warp & guidance */
  readonly edge: number;
  readonly surfacePressure: number;
  sample(altitude: number, out: AtmosphereSample): AtmosphereSample;
}

const R_AIR = 287.053; // J/(kg K)
const GAMMA = 1.4;
const G0 = 9.80665;
const M0 = 0.0289644;
const R_STAR = 8.3144598;
const GMR = (G0 * M0) / R_STAR; // K/m
const R0 = 6_356_766; // m, effective Earth radius for geopotential altitude

// Base geopotential heights (m), temperatures (K), lapse rates (K/m), pressures (Pa)
const HB = [0, 11000, 20000, 32000, 47000, 51000, 71000, 84852];
const TB = [288.15, 216.65, 216.65, 228.65, 270.65, 270.65, 214.65, 186.946];
const LB = [-0.0065, 0, 0.001, 0.0028, 0, -0.0028, -0.002, 0];
const PB = [101325, 22632.06, 5474.889, 868.0187, 110.9063, 66.93887, 3.95642, 0.3734];

// Upper atmosphere density table (geometric altitude km -> kg/m^3), USSA-1976
const UPPER: [number, number, number][] = [
  // alt km, density, temperature K
  [86, 6.958e-6, 186.87],
  [90, 3.416e-6, 186.87],
  [95, 1.393e-6, 188.42],
  [100, 5.604e-7, 195.08],
  [110, 9.708e-8, 240.0],
  [120, 2.222e-8, 360.0],
  [130, 8.152e-9, 469.27],
  [140, 3.831e-9, 559.63],
  [150, 2.076e-9, 634.39],
  [175, 6.234e-10, 761.4],
  [200, 2.541e-10, 854.56],
  [250, 6.073e-11, 941.33],
  [300, 1.916e-11, 976.01],
  [350, 7.014e-12, 990.06],
  [400, 2.803e-12, 995.83],
  [450, 1.184e-12, 998.22],
  [500, 5.215e-13, 999.24],
  [600, 1.137e-13, 999.85],
  [700, 3.07e-14, 999.97],
  [800, 1.136e-14, 999.99],
  [900, 5.759e-15, 1000],
  [1000, 3.561e-15, 1000],
];

class USSA1976 implements AtmosphereModel {
  readonly top = 1_000_000;
  readonly edge = 140_000;
  readonly surfacePressure = 101325;

  sample(h: number, out: AtmosphereSample): AtmosphereSample {
    if (h < -500) h = -500;
    if (h <= 86000) {
      const H = (R0 * h) / (R0 + h);
      let i = 0;
      while (i < HB.length - 1 && H >= HB[i + 1]) i++;
      const Tb = TB[i], Lb = LB[i], Pb = PB[i], dh = H - HB[i];
      let T: number, P: number;
      if (Lb !== 0) {
        T = Tb + Lb * dh;
        P = Pb * Math.pow(Tb / T, GMR / Lb);
      } else {
        T = Tb;
        P = Pb * Math.exp((-GMR * dh) / Tb);
      }
      out.temperature = T;
      out.pressure = P;
      out.density = P / (R_AIR * T);
      out.speedOfSound = Math.sqrt(GAMMA * R_AIR * T);
      return out;
    }
    if (h >= this.top) {
      out.temperature = 1000; out.pressure = 0; out.density = 0;
      out.speedOfSound = Math.sqrt(GAMMA * R_AIR * 186.87);
      return out;
    }
    const km = h / 1000;
    let i = 0;
    while (i < UPPER.length - 2 && km >= UPPER[i + 1][0]) i++;
    const [h0, d0, t0] = UPPER[i];
    const [h1, d1, t1] = UPPER[i + 1];
    const f = (km - h0) / (h1 - h0);
    const rho = Math.exp(Math.log(d0) + (Math.log(d1) - Math.log(d0)) * f);
    const T = t0 + (t1 - t0) * f;
    out.density = rho;
    out.temperature = T;
    out.pressure = rho * R_AIR * T;
    // Continuum speed of sound is meaningless up here; keep the mesopause value so Mach stays sane.
    out.speedOfSound = Math.sqrt(GAMMA * R_AIR * 186.87);
    return out;
  }
}

export class ExponentialAtmosphere implements AtmosphereModel {
  readonly surfacePressure: number;
  readonly edge: number;
  constructor(
    readonly surfaceDensity: number,
    readonly scaleHeight: number,
    readonly top: number,
    readonly temperature: number,
    readonly molarScale = 1, // multiplies R_AIR inversely (CO2 heavier, H2 lighter)
  ) {
    this.surfacePressure = surfaceDensity * (R_AIR / molarScale) * temperature;
    this.edge = Math.min(top, scaleHeight * 11);
  }
  sample(h: number, out: AtmosphereSample): AtmosphereSample {
    if (h >= this.top) {
      out.density = 0; out.pressure = 0; out.temperature = this.temperature;
      out.speedOfSound = Math.sqrt(1.3 * (R_AIR / this.molarScale) * this.temperature);
      return out;
    }
    const rho = this.surfaceDensity * Math.exp(-Math.max(h, -2000) / this.scaleHeight);
    out.density = rho;
    out.temperature = this.temperature;
    out.pressure = rho * (R_AIR / this.molarScale) * this.temperature;
    out.speedOfSound = Math.sqrt(1.3 * (R_AIR / this.molarScale) * this.temperature);
    return out;
  }
}

export const EarthAtmosphere: AtmosphereModel = new USSA1976();

export function newAtmosphereSample(): AtmosphereSample {
  return { pressure: 0, density: 0, temperature: 288.15, speedOfSound: 340.3 };
}
