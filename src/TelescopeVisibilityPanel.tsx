import { useMemo, useState } from "react";
import type { ObservingTelescope } from "./data";
import { siteForTelescopeCode } from "./telescopeSites";
import { altitudeDegEquatorial, sunAltitudeDeg } from "./visibilityAstro";

const VIS_COLORS = ["#67e8f9", "#a78bfa", "#fbbf24", "#f472b6", "#4ade80", "#fb923c", "#94a3b8"];

/** Solar altitude reference lines (degrees); intersections with dashed Sun curves mark twilight at that site. */
const TWILIGHT_GUIDES = [
  { alt: -18, short: "−18°", sub: "astro" },
  { alt: -12, short: "−12°", sub: "nautical" },
  { alt: -6, short: "−6°", sub: "civil" },
] as const;

function formatUtcDateIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addUtcDays(isoDate: string, deltaDays: number): string {
  const [y, mo, da] = isoDate.split("-").map(Number);
  const t = Date.UTC(y, mo - 1, da) + deltaDays * 86400000;
  return formatUtcDateIso(new Date(t));
}

function utcDayOffsetFromToday(isoDate: string): number {
  const today = formatUtcDateIso(new Date());
  const a = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 1,
    Number(today.slice(8, 10)),
  );
  const b = Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)));
  return Math.round((b - a) / 86400000);
}

/**
 * Local mean solar time (fractional hour in [0, 24)), ignoring DST.
 * At longitude λ° east: LMST civil hour-of-day ≈ UTC fractional hour + λ/15.
 */
function localMeanSolarHourDecimal(dateUtc: Date, lonEastDeg: number): number {
  const utcFrac =
    dateUtc.getUTCHours() +
    dateUtc.getUTCMinutes() / 60 +
    dateUtc.getUTCSeconds() / 3600 +
    dateUtc.getUTCMilliseconds() / 3600000;
  let lm = utcFrac + lonEastDeg / 15;
  lm %= 24;
  if (lm < 0) lm += 24;
  return lm;
}

/** Break polyline when local hour wraps backward past midnight (UTC march is forward). */
function splitPointsByLocalHourWrap<T extends { localHour: number }>(pts: T[]): T[][] {
  if (!pts.length) return [];
  const segments: T[][] = [];
  let cur: T[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].localHour - pts[i - 1].localHour < -6) {
      segments.push(cur);
      cur = [pts[i]];
    } else {
      cur.push(pts[i]);
    }
  }
  segments.push(cur);
  return segments;
}

function pathFromLocalHourSegment(
  seg: { localHour: number; altDeg: number }[],
  xScale: (h: number) => number,
  yScale: (a: number) => number,
): string {
  return seg.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.localHour)} ${yScale(p.altDeg)}`).join(" ");
}

/** Dedupe preserving first-seen order (matches follow-up facility list). */
function dedupeFacilityCodes(codes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) {
    const t = String(c).trim();
    if (!t || seen.has(t)) {
      continue;
    }
    seen.add(t);
    out.push(t);
  }
  return out;
}

function sampleSunAltitudesUtcDay(
  latDeg: number,
  lonEastDeg: number,
  utcDateIso: string,
  minutesStep: number,
): { hourUtc: number; localHour: number; altDeg: number }[] {
  const [y, mo, da] = utcDateIso.split("-").map(Number);
  const out: { hourUtc: number; localHour: number; altDeg: number }[] = [];
  for (let m = 0; m <= 24 * 60; m += minutesStep) {
    const d = new Date(Date.UTC(y, mo - 1, da, 0, m, 0, 0));
    const hourUtc = m / 60;
    const localHour = localMeanSolarHourDecimal(d, lonEastDeg);
    const alt = sunAltitudeDeg(latDeg, lonEastDeg, d);
    out.push({ hourUtc, localHour, altDeg: alt });
  }
  return out;
}

function sampleAltitudesUtcDay(
  raDeg: number,
  decDeg: number,
  latDeg: number,
  lonEastDeg: number,
  utcDateIso: string,
  minutesStep: number,
): { hourUtc: number; localHour: number; altDeg: number }[] {
  const [y, mo, da] = utcDateIso.split("-").map(Number);
  const out: { hourUtc: number; localHour: number; altDeg: number }[] = [];
  for (let m = 0; m <= 24 * 60; m += minutesStep) {
    const d = new Date(Date.UTC(y, mo - 1, da, 0, m, 0, 0));
    const hourUtc = m / 60;
    const localHour = localMeanSolarHourDecimal(d, lonEastDeg);
    const alt = altitudeDegEquatorial(raDeg, decDeg, latDeg, lonEastDeg, d);
    out.push({ hourUtc, localHour, altDeg: alt });
  }
  return out;
}

export function TelescopeVisibilityPanel({
  raDeg,
  decDeg,
  telescopes,
  telescopeCodes,
}: {
  raDeg: number;
  decDeg: number;
  telescopes: ObservingTelescope[];
  /** Same codes as follow-up observing facilities (object.telescope_codes). */
  telescopeCodes: string[];
}) {
  const todayIso = formatUtcDateIso(new Date());
  const [utcDate, setUtcDate] = useState(todayIso);

  const assignedCodes = useMemo(() => dedupeFacilityCodes(telescopeCodes), [telescopeCodes]);

  const codesWithSites = useMemo(
    () => assignedCodes.filter((c) => siteForTelescopeCode(c)),
    [assignedCodes],
  );

  const codesMissingSites = useMemo(
    () => assignedCodes.filter((c) => !siteForTelescopeCode(c)),
    [assignedCodes],
  );

  const dayOffset = utcDayOffsetFromToday(utcDate);

  const series = useMemo(() => {
    return codesWithSites.map((code, idx) => {
      const site = siteForTelescopeCode(code)!;
      const pts = sampleAltitudesUtcDay(raDeg, decDeg, site.latDeg, site.lonEastDeg, utcDate, 15);
      const sunPts = sampleSunAltitudesUtcDay(site.latDeg, site.lonEastDeg, utcDate, 15);
      return {
        code,
        label: telescopes.find((t) => t.code === code)?.displayName ?? code,
        color: VIS_COLORS[idx % VIS_COLORS.length],
        pts,
        sunPts,
      };
    });
  }, [codesWithSites, raDeg, decDeg, utcDate, telescopes]);

  const padL = 58;
  const padR = 12;
  const padT = 18;
  const padB = 52;
  const W = 532;
  const H = 272;
  const altMin = -22;
  const altMax = 90;
  const spanAlt = altMax - altMin;

  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xScale = (hour: number) => padL + (hour / 24) * innerW;
  const yScale = (alt: number) => padT + ((altMax - alt) / spanAlt) * innerH;

  return (
    <div className="detail-visibility-stack">
      <p className="detail-visibility-merge-hint">
        Curves use the observing facilities selected above (same <code>telescope_codes</code> saved with this object).
      </p>

      <div className="detail-visibility-controls">
        <label className="detail-visibility-date-field">
          <span className="detail-visibility-label">UTC date</span>
          <input
            type="date"
            value={utcDate}
            min={addUtcDays(todayIso, -365)}
            max={addUtcDays(todayIso, 365)}
            onChange={(e) => setUtcDate(e.target.value)}
          />
        </label>
        <label className="detail-visibility-slider-field">
          <span className="detail-visibility-label">
            Shift ({dayOffset >= 0 ? "+" : ""}
            {dayOffset} d from today)
          </span>
          <input
            type="range"
            min={0}
            max={120}
            step={1}
            value={Math.min(120, Math.max(-30, dayOffset))}
            onChange={(e) => setUtcDate(addUtcDays(todayIso, Number(e.target.value)))}
          />
        </label>
      </div>

      {!Number.isFinite(raDeg) || !Number.isFinite(decDeg) ? (
        <p className="muted-value">Invalid RA/Dec for visibility plot.</p>
      ) : assignedCodes.length === 0 ? (
        <p className="muted-value">Add at least one observing facility above to plot target altitude through the night.</p>
      ) : codesWithSites.length === 0 ? (
        <p className="muted-value">
          None of the assigned facilities have built-in site coordinates yet ({codesMissingSites.join(", ")}). Add
          lat/lon to the catalog mapping when ready.
        </p>
      ) : (
        <>
          {codesMissingSites.length > 0 ? (
            <p className="detail-visibility-warn muted-value">
              Skipping facilities without site coords: {codesMissingSites.join(", ")}.
            </p>
          ) : null}
          <div className="detail-visibility-chart-wrap">
            <svg className="detail-visibility-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Altitude plot">
              <title>
                Target and solar altitude vs local mean solar time per site; dashed Sun curves show twilight at each
                telescope
              </title>
              {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                const hour = t * 24;
                const x = xScale(hour);
                return (
                  <g key={`vx-${t}`}>
                    <line
                      x1={x}
                      y1={padT}
                      x2={x}
                      y2={H - padB}
                      stroke="rgba(148,163,184,0.12)"
                      strokeWidth={1}
                    />
                    <text x={x} y={H - padB + 16} textAnchor="middle" fill="#94a3b8" fontSize={9}>
                      {hour === 0 ? "0 (midnight)" : hour === 24 ? "24h" : `${hour}h`}
                    </text>
                  </g>
                );
              })}
              {[-18, -12, -6, 0, 30, 60, 90].map((alt) => {
                const y = yScale(alt);
                const tw = TWILIGHT_GUIDES.find((g) => g.alt === alt);
                return (
                  <g key={`vy-${alt}`}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={W - padR}
                      y2={y}
                      stroke={
                        tw
                          ? alt === -18
                            ? "rgba(129,140,248,0.35)"
                            : alt === -12
                              ? "rgba(96,165,250,0.32)"
                              : "rgba(251,191,36,0.3)"
                          : alt === 0
                            ? "rgba(248,250,252,0.22)"
                            : "rgba(148,163,184,0.12)"
                      }
                      strokeWidth={1}
                      strokeDasharray={tw || alt === 0 ? "3 3" : undefined}
                    />
                    <text x={padL - 6} y={y + (alt < 0 ? 3 : 4)} textAnchor="end" fill="#94a3b8" fontSize={alt < 0 ? 8 : 9}>
                      {tw ? `${tw.short} ${tw.sub}` : `${alt}°`}
                    </text>
                  </g>
                );
              })}
              <line
                x1={padL}
                x2={W - padR}
                y1={yScale(30)}
                y2={yScale(30)}
                stroke="rgba(251,191,36,0.35)"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <text x={W - padR - 2} y={yScale(30) - 4} textAnchor="end" fill="#ca8a04" fontSize={8}>
                ~30° target floor
              </text>
              <line
                x1={xScale(0)}
                y1={padT}
                x2={xScale(0)}
                y2={H - padB}
                stroke="rgba(248,250,252,0.14)"
                strokeWidth={1}
                strokeDasharray="2 4"
              />
              {series.map((s) =>
                splitPointsByLocalHourWrap(s.sunPts).map((seg, si) => (
                  <path
                    key={`sun-${s.code}-${si}`}
                    d={pathFromLocalHourSegment(seg, xScale, yScale)}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={1.35}
                    strokeDasharray="6 5"
                    opacity={0.62}
                    strokeLinejoin="round"
                  />
                )),
              )}
              {series.map((s) =>
                splitPointsByLocalHourWrap(s.pts).map((seg, si) => (
                  <path
                    key={`${s.code}-${si}`}
                    d={pathFromLocalHourSegment(seg, xScale, yScale)}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                  />
                )),
              )}
              <text
                x={padL + innerW / 2}
                y={H - 6}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize={10}
                fontWeight={600}
                className="chart-axis-title"
              >
                Local mean solar hour (0 = midnight; no DST)
              </text>
              <text
                transform={`translate(14, ${padT + innerH / 2}) rotate(-90)`}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize={10}
                fontWeight={600}
                className="chart-axis-title"
              >
                Altitude (°)
              </text>
            </svg>
            <ul className="detail-visibility-legend">
              {series.map((s) => (
                <li key={s.code}>
                  <span className="detail-visibility-legend-lines" aria-hidden>
                    <span className="detail-visibility-leg-solid" style={{ background: s.color }} />
                    <span className="detail-visibility-leg-dashed" style={{ borderColor: s.color }} />
                  </span>
                  {s.label}
                </li>
              ))}
            </ul>
            <p className="detail-visibility-footnote">
              Sampling spans UTC calendar day <strong>{utcDate}</strong>; each curve uses that site’s{" "}
              <strong>local mean solar time</strong> (UTC + longitude/15°, not civil timezone/DST). Compare target vs
              dashed Sun after local dusk (−6°/−12°/−18° guides) and after <strong>0h</strong> (midnight). Curves can
              split where local midnight falls inside the UTC window.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
