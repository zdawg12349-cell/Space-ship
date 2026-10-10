import { Vector3 } from 'three';

/**
 * Physical atmosphere description (Hillaire 2020 / Bruneton 2017 conventions), lengths in km.
 * Scattering coefficients are per km.
 */
export interface AtmosphereParams {
  bottomRadius: number;
  topRadius: number;
  rayleighScattering: Vector3;
  rayleighScaleHeight: number;
  mieScattering: number;
  mieExtinction: number;
  mieScaleHeight: number;
  mieG: number;
  absorptionExtinction: Vector3; // ozone
  absorptionCenter: number;
  absorptionWidth: number;
  groundAlbedo: Vector3;
  /** solar illuminance at the top of the atmosphere, rendering units (kcd·sr scale) */
  sunIlluminance: Vector3;
  /** multiplier on multiple scattering (artistic, 1 = physical approx) */
  multiScatteringFactor: number;
}

export function earthAtmosphere(): AtmosphereParams {
  return {
    bottomRadius: 6371.0,
    topRadius: 6371.0 + 100.0,
    rayleighScattering: new Vector3(5.802e-3, 13.558e-3, 33.1e-3),
    rayleighScaleHeight: 8.0,
    mieScattering: 3.996e-3,
    mieExtinction: 4.44e-3,
    mieScaleHeight: 1.2,
    mieG: 0.8,
    absorptionExtinction: new Vector3(0.65e-3, 1.881e-3, 0.085e-3),
    absorptionCenter: 25.0,
    absorptionWidth: 30.0,
    groundAlbedo: new Vector3(0.3, 0.3, 0.3),
    sunIlluminance: new Vector3(1.0, 0.982, 0.94).multiplyScalar(110.0),
    multiScatteringFactor: 1.0,
  };
}

/** Thin, dusty CO2 atmosphere: butterscotch daytime sky, blue sunsets. */
export function marsAtmosphere(): AtmosphereParams {
  return {
    bottomRadius: 3389.5,
    topRadius: 3389.5 + 60.0,
    rayleighScattering: new Vector3(0.19e-3, 0.1e-3, 0.057e-3),
    rayleighScaleHeight: 11.1,
    mieScattering: 0.03,
    mieExtinction: 0.033,
    mieScaleHeight: 11.0,
    mieG: 0.76,
    absorptionExtinction: new Vector3(0.0, 0.0, 0.0),
    absorptionCenter: 0,
    absorptionWidth: 1,
    groundAlbedo: new Vector3(0.25, 0.14, 0.08),
    sunIlluminance: new Vector3(1.0, 0.982, 0.94).multiplyScalar(47.0),
    multiScatteringFactor: 1.0,
  };
}
