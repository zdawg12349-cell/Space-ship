import type { SiteDef } from '../render/planet/heightfield';

/** Launch sites (real geographic locations; pad layouts are original). */
export interface LaunchSite {
  id: string;
  name: string;
  region: string;
  lat: number; // deg
  lon: number; // deg
  padHeight: number; // m above sea level
  coastBearing: number; // deg, toward the sea
  coastDistance: number; // m
  inland: boolean;
  description: string;
  /** typical recovery: landing zone offset from pad (m east, m north) */
  lz: [number, number];
  climate: 'subtropical' | 'tropical' | 'steppe' | 'coastal' | 'arid';
}

export const LAUNCH_SITES: LaunchSite[] = [
  { id: 'cape', name: 'Cape Canaveral', region: 'Florida, USA', lat: 28.6084, lon: -80.6043, padHeight: 14, coastBearing: 72, coastDistance: 1300, inland: false, lz: [3200, -7800], climate: 'subtropical',
    description: 'Atlantic coast launch complex. Due-east launches gain 409 m/s from Earth\'s rotation; boosters return to coastal landing zones.' },
  { id: 'boca', name: 'Boca Chica', region: 'Texas, USA', lat: 25.9970, lon: -97.1570, padHeight: 3, coastBearing: 90, coastDistance: 650, inland: false, lz: [0, 0], climate: 'coastal',
    description: 'Flat Gulf-coast dunes and tidal flats. Home of the super-heavy pad and its booster-catching tower.' },
  { id: 'kourou', name: 'Kourou', region: 'French Guiana', lat: 5.2360, lon: -52.7750, padHeight: 18, coastBearing: 35, coastDistance: 4200, inland: false, lz: [2500, 6000], climate: 'tropical',
    description: 'Five degrees from the equator: the most efficient path to geostationary orbit. Rainforest to the horizon.' },
  { id: 'baikonur', name: 'Baikonur', region: 'Kazakhstan', lat: 45.9650, lon: 63.3050, padHeight: 92, coastBearing: 0, coastDistance: 0, inland: true, lz: [0, 0], climate: 'steppe',
    description: 'The steppe launch site. Spent stages fall on empty grassland; crews land on solid ground under parachute.' },
  { id: 'vandenberg', name: 'Vandenberg', region: 'California, USA', lat: 34.6320, lon: -120.6110, padHeight: 110, coastBearing: 255, coastDistance: 1600, inland: false, lz: [-600, 1500], climate: 'coastal',
    description: 'Pacific coast cliffs and fog banks. Southward launches reach polar and sun-synchronous orbits.' },
  { id: 'tanegashima', name: 'Tanegashima', region: 'Japan', lat: 30.4000, lon: 130.9680, padHeight: 30, coastBearing: 135, coastDistance: 350, inland: false, lz: [0, 0], climate: 'subtropical',
    description: 'Often called the most beautiful launch site on Earth: a pad on a green cape above the Pacific surf.' },
  { id: 'wenchang', name: 'Wenchang', region: 'Hainan, China', lat: 19.6140, lon: 110.9510, padHeight: 10, coastBearing: 95, coastDistance: 1100, inland: false, lz: [0, 0], climate: 'tropical',
    description: 'Tropical island coast with coconut palms. Low latitude and an ocean downrange for heavy-lift launches.' },
];

export function siteDir(s: { lat: number; lon: number }): [number, number, number] {
  const la = (s.lat * Math.PI) / 180, lo = (s.lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

export function siteToHeightDef(s: LaunchSite): SiteDef {
  return {
    id: s.id, dir: siteDir(s), padHeight: s.padHeight, flatRadius: 650, blendRadius: 1600,
    coastBearing: (s.coastBearing * Math.PI) / 180, coastDistance: s.coastDistance, regionRadius: 26000, inland: s.inland,
  };
}

/** Body-fixed direction of a point offset (east, north) metres from a site. */
export function offsetDir(s: { lat: number; lon: number }, east: number, north: number, R = 6371000): [number, number, number] {
  const la = (s.lat * Math.PI) / 180, lo = (s.lon * Math.PI) / 180;
  const lat2 = la + north / R;
  const lon2 = lo + east / (R * Math.cos(la));
  return [Math.cos(lat2) * Math.cos(lon2), Math.cos(lat2) * Math.sin(lon2), Math.sin(lat2)];
}
