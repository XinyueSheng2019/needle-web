/** Julian date (UT), including fractional day. */
export function julianDateUtc(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function mod360(deg: number): number {
  let x = deg % 360;
  if (x < 0) {
    x += 360;
  }
  return x;
}

/** Greenwich mean sidereal time in degrees at Julian date JD (UT). */
export function greenwichMeanSiderealDegrees(jd: number): number {
  const D = jd - 2451545.0;
  const T = D / 36525;
  const gmst =
    280.46061837 +
    360.98564736629 * D +
    0.000387933 * T * T -
    (T * T * T) / 38710000;
  return mod360(gmst);
}

export function localMeanSiderealDegrees(jd: number, lonEastDeg: number): number {
  return mod360(greenwichMeanSiderealDegrees(jd) + lonEastDeg);
}

/**
 * Altitude (degrees) of (RA, Dec) equatorial coordinates at geographic lat/lon (east positive), instant `date` UTC.
 * RA and Dec in degrees.
 */
export function altitudeDegEquatorial(
  raDeg: number,
  decDeg: number,
  latDeg: number,
  lonEastDeg: number,
  date: Date,
): number {
  const jd = julianDateUtc(date);
  const lstDeg = localMeanSiderealDegrees(jd, lonEastDeg);
  const haDeg = mod360(lstDeg - raDeg);
  const haRad = (haDeg * Math.PI) / 180;
  const decRad = (decDeg * Math.PI) / 180;
  const latRad = (latDeg * Math.PI) / 180;
  const sinAlt =
    Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(haRad);
  const clamped = Math.min(1, Math.max(-1, sinAlt));
  return (Math.asin(clamped) * 180) / Math.PI;
}

/**
 * Approximate apparent Sun equatorial coordinates (degrees, equinox of date) for twilight / altitude plots.
 * Good enough for ± few arcmin; based on Meeus-style low-precision solar ephemeris.
 */
export function sunRaDecDeg(date: Date): { raDeg: number; decDeg: number } {
  const jd = julianDateUtc(date);
  const T = (jd - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const Mnorm = ((M % 360) + 360) % 360;
  const Mrad = (Mnorm * Math.PI) / 180;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mrad) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad) +
    0.000289 * Math.sin(3 * Mrad);
  const sunLon = mod360(L0 + C);
  const lambda = (sunLon * Math.PI) / 180;
  const epsDeg =
    23.4392911111 - 0.013004167 * T - 0.000000164 * T * T + 0.000000504 * T * T * T;
  const epsilon = (epsDeg * Math.PI) / 180;
  const raRad = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  let raDeg = (raRad * 180) / Math.PI;
  if (raDeg < 0) {
    raDeg += 360;
  }
  const decRad = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const decDeg = (decRad * 180) / Math.PI;
  return { raDeg, decDeg };
}

/** Solar altitude (degrees) at geographic site and UTC instant; geometric horizon. */
export function sunAltitudeDeg(latDeg: number, lonEastDeg: number, date: Date): number {
  const { raDeg, decDeg } = sunRaDecDeg(date);
  return altitudeDegEquatorial(raDeg, decDeg, latDeg, lonEastDeg, date);
}
