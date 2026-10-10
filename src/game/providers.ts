import { Vector3 } from 'three';
import type { CelestialBody } from '../physics/bodies';
import type { TerrainProvider, WeatherProvider } from '../physics/vessel';
import { HeightContext, HeightSample, sampleHeight } from '../render/planet/heightfield';

/**
 * Physics-side terrain and weather. Terrain uses exactly the same height functions as the
 * renderer's terrain mesher, so the ground the vehicle touches is the ground that is drawn.
 */
/**
 * A flat landing surface laid over the terrain (landing-zone pad, drone-ship deck): inside its
 * footprint the ground is at `height` and never water. Body-fixed; the footprint is a rectangle
 * in the local tangent plane (half sizes along `axis` and across it).
 */
export interface Platform {
  bodyId: string;
  /** body-fixed unit direction of the centre */
  dir: Vector3;
  /** deck height above the body's reference radius (m) */
  height: number;
  halfLength: number;
  halfWidth: number;
  /** body-fixed unit vector of the long axis (tangent at the centre) */
  axis: Vector3;
  /** circular footprint instead of a rectangle (radius = halfLength) */
  round?: boolean;
}

const _pd = new Vector3();

export class GameTerrain implements TerrainProvider {
  private hs: HeightSample = { h: 0, water: 0, sand: 0, flat: 0 };
  platforms: Platform[] = [];
  constructor(private readonly earth: HeightContext, private readonly moon: HeightContext) {}

  /** Platform under a body-fixed direction, if any. */
  platformAt(body: CelestialBody, dir: Vector3): Platform | null {
    for (const p of this.platforms) {
      if (p.bodyId !== body.id) continue;
      const R = body.radius;
      // tangent-plane offset from the centre (metres)
      _pd.copy(dir).sub(p.dir).multiplyScalar(R);
      const along = _pd.dot(p.axis);
      const across = Math.sqrt(Math.max(0, _pd.lengthSq() - along * along - Math.pow(_pd.dot(p.dir), 2)));
      if (p.round ? Math.hypot(along, across) <= p.halfLength : Math.abs(along) <= p.halfLength && across <= p.halfWidth) return p;
    }
    return null;
  }

  heightAt(body: CelestialBody, dir: Vector3): number {
    const ctx = body.id === 'earth' ? this.earth : body.id === 'moon' ? this.moon : null;
    if (!ctx) return 0;
    const h = sampleHeight(ctx, dir.x, dir.y, dir.z, this.hs, 1, 0).h;
    if (this.platforms.length) {
      const p = this.platformAt(body, dir);
      if (p) return Math.max(p.height, this.hs.water > 0.5 ? p.height : h);
    }
    return h;
  }

  isWater(body: CelestialBody, dir: Vector3): boolean {
    if (body.id !== 'earth') return false;
    if (this.platforms.length && this.platformAt(body, dir)) return false;
    sampleHeight(this.earth, dir.x, dir.y, dir.z, this.hs, 1, 0);
    return this.hs.water > 0.5;
  }
}

export type WeatherKind = 'clear' | 'fair' | 'breezy' | 'overcast' | 'storm';

export interface WeatherState {
  kind: WeatherKind;
  /** surface wind speed (m/s) and direction it blows TOWARD (rad from north) */
  surfaceWind: number;
  windDir: number;
  /** jet stream peak (m/s) near 11 km */
  jetStream: number;
  /** low-level gusts / turbulence 0..1 */
  gustiness: number;
  /** cloud cover 0..1 (renderer) */
  clouds: number;
}

export const WEATHER_PRESETS: Record<WeatherKind, Omit<WeatherState, 'kind' | 'windDir'>> = {
  clear: { surfaceWind: 2, jetStream: 25, gustiness: 0.05, clouds: 0.25 },
  fair: { surfaceWind: 4, jetStream: 35, gustiness: 0.15, clouds: 0.55 },
  breezy: { surfaceWind: 8, jetStream: 45, gustiness: 0.35, clouds: 0.7 },
  overcast: { surfaceWind: 6, jetStream: 40, gustiness: 0.3, clouds: 1.0 },
  storm: { surfaceWind: 13, jetStream: 60, gustiness: 0.7, clouds: 1.0 },
};

/**
 * Wind profile: logarithmic boundary layer, veering with height, a jet stream core near the
 * tropopause, light winds in the stratosphere. Gusts are smooth pseudo-random functions of
 * time and position so the vehicle sees coherent buffeting rather than white noise.
 */
export class GameWeather implements WeatherProvider {
  state: WeatherState;
  constructor(state: WeatherState) { this.state = state; }

  windAt(body: CelestialBody, lat: number, lon: number, alt: number, t: number, out: Vector3): Vector3 {
    if (body.id !== 'earth' || alt > 60_000) return out.set(0, 0, 0);
    const s = this.state;
    const h = Math.max(1, alt);
    // boundary layer (log profile to ~1 km)
    const bl = s.surfaceWind * Math.min(1.6, Math.log(h / 0.3 + 1) / Math.log(10 / 0.3 + 1));
    // jet stream: gaussian around 11 km
    const jet = s.jetStream * Math.exp(-Math.pow((alt - 11_000) / 4500, 2));
    const strat = alt > 16_000 ? 8 * Math.exp(-(alt - 16_000) / 15_000) : 0;
    const speed = alt < 1500 ? bl : bl * Math.exp(-(alt - 1500) / 6000) + jet + strat;
    // veer with height (Ekman) toward westerlies aloft
    const dir = s.windDir + Math.min(1, alt / 3000) * 0.6;
    const g = s.gustiness;
    const gx = g * (Math.sin(t * 0.37 + lat * 1e3) * 0.6 + Math.sin(t * 1.13 + lon * 7e2) * 0.4) * (3 + alt / 2000);
    const gz = g * (Math.sin(t * 0.53 + lon * 1e3) * 0.6 + Math.sin(t * 1.71 + lat * 9e2) * 0.4) * (3 + alt / 2000);
    // ENU: x = east, y = north, z = up
    return out.set(Math.sin(dir) * speed + gx, Math.cos(dir) * speed + gz, 0);
  }

  turbulence(alt: number): number {
    const s = this.state;
    if (alt > 20_000) return 0;
    return s.gustiness * Math.exp(-alt / 3000) + (s.kind === 'storm' ? 0.3 * Math.exp(-Math.pow((alt - 8000) / 4000, 2)) : 0);
  }
}
