// Physical constants (SI). Sources: IAU 2015 / JPL SSD, CODATA 2018, US Standard Atmosphere 1976.
export const G = 6.6743e-11;
export const G0 = 9.80665; // standard gravity, m/s^2
export const AU = 1.495978707e11; // m
export const DAY = 86400;
export const JULIAN_CENTURY = 36525 * DAY;
export const JD_J2000 = 2451545.0;
export const OBLIQUITY_J2000 = 23.4392911 * Math.PI / 180; // mean obliquity of the ecliptic
export const STEFAN_BOLTZMANN = 5.670374419e-8;
export const SPEED_OF_LIGHT = 299792458;
export const SOLAR_CONSTANT = 1361; // W/m^2 at 1 AU
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Convert a JS Date to seconds since J2000.0 (TT ≈ UTC for our purposes). */
export function dateToJ2000Seconds(d: Date): number {
  const jd = d.getTime() / 86400000 + 2440587.5;
  return (jd - JD_J2000) * DAY;
}

export function j2000SecondsToDate(t: number): Date {
  const jd = t / DAY + JD_J2000;
  return new Date((jd - 2440587.5) * 86400000);
}
