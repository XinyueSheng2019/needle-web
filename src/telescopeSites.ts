/**
 * Approximate WGS84 sites for visibility / altitude plots (prototype).
 * Keys match `observing_telescopes.code` (uppercase). Extend as facilities are added.
 */
export type TelescopeSite = {
  latDeg: number;
  lonEastDeg: number;
  /** metres — reserved for future refraction / dome limits */
  elevationM?: number;
};

export const TELESCOPE_SITES: Record<string, TelescopeSite> = {
  LT: { latDeg: 28.7624, lonEastDeg: -17.8792, elevationM: 2326 },
  NTT: { latDeg: -29.2597, lonEastDeg: -70.7328, elevationM: 2335 },
  SOAR: { latDeg: -30.2379, lonEastDeg: -70.7339, elevationM: 2738 },
  VLT: { latDeg: -24.6272, lonEastDeg: -70.4042, elevationM: 2635 },
  GEMINI_NORTH: { latDeg: 19.8258, lonEastDeg: -155.4691, elevationM: 4215 },
};

export function siteForTelescopeCode(code: string): TelescopeSite | undefined {
  const key = code.trim();
  if (!key) {
    return undefined;
  }
  if (TELESCOPE_SITES[key]) {
    return TELESCOPE_SITES[key];
  }
  const upper = key.toUpperCase();
  return TELESCOPE_SITES[upper];
}
