export type ObjectClass =
  | "TDE"
  | "SLSNe-I"
  | "SN Ia"
  | "SN Ibc"
  | "SN II"
  | "Unclear"
  | "AGN-removed"
  | "Other";

export type FollowUpStatus = "To Do" | "Observing" | "Completed" | "Snooze";

export type ObjectComment = {
  id: string;
  publisher: string;
  body: string;
  createdAt: string;
};

/**
 * Single photometry point after API normalization.
 * The database may store flat `{mjd,band,mag}` rows or a mag_sets_v4 blob (`candidates[]` with `magpsf` / `fid`);
 * the server flattens both to this shape.
 */
export type SurveyId = "ZTF" | "LSST" | "ATLAS";

export type PhotometryPoint = {
  mjd: number;
  band: string;
  mag: number;
  magErr?: number;
  flux?: number;
  fluxErr?: number;
};

/** Latest NEEDLE classification per UTC day (minimum cadence: 1 day) for history plots. */
export type DailyClassification = {
  day: string;
  classifiedAt: string;
  class: ObjectClass;
  confidence: number;
  rawProbs: Record<string, number>;
  modelVersion: string;
};

export type ObjectDetailPayload = {
  photometry: PhotometryPoint[];
  classificationHistory: DailyClassification[];
};

export type TransientObject = {
  id: string;
  name: string;
  lasairId: string;
  ra: string;
  dec: string;
  magnitude: string;
  band: string;
  lastClassified: string;
  classifiedBy: string;
  classification: ObjectClass;
  tnsClass: string | null;
  tnsName: string | null;
  /** Legacy survey / stamp image URLs (Pan-STARRS cutouts, etc.). */
  psImageUrls: string[];
  confidence: number;
  classProbabilities: Record<string, number>;
  comment: string;
  comments: ObjectComment[];
  starred: boolean;
  promoted: boolean;
  snoozed: boolean;
  followUp: FollowUpStatus;
  priority: "High" | "Medium" | "Low" | "Monitor";
  /** ISO 8601 — latest user interaction, follow-up queue touch, or classification time (for sorting). */
  lastActionAt: string;
  /** When to revisit this object (follow-up reminder). */
  revisitAt: string | null;
  /** Observing facility codes from `observing_telescopes` (unique, order preserved). */
  telescopeCodes: string[];
  /** First facility code (convenience for single-select / exports). */
  telescopeCode: string | null;
  agnRemoved: boolean;
  qualityFlags: string[];
  imageHue: string;
};

export type Metric = {
  label: string;
  value: string;
  delta: string;
};

export type ChartDay = {
  day: string;
  tde: number;
  slsn: number;
  sn: number;
  unclear: number;
  agn: number;
  confidence: number;
};

export type TeamSummary = {
  name: string;
  members: number;
  collections: number;
  permission: string;
};

export type AnnotationSummary = {
  author: string;
  body: string;
};

export type ObservingTelescope = {
  code: string;
  displayName: string;
};

/** Session flags from `/api/dashboard` (drives UI affordances). */
export type PlatformSession = {
  /**
   * Private / personal workspace accounts may star objects; shared or institutional accounts see stars but cannot change them.
   * Server uses `users.preferences->>'accountKind'` (`private` vs `shared`) or `CAN_EDIT_STARRED`.
   */
  canEditStarred: boolean;
};

export type PlatformData = {
  objects: TransientObject[];
  metrics: Metric[];
  chartDays: ChartDay[];
  teams: TeamSummary[];
  auditEvents: string[];
  annotations: AnnotationSummary[];
  telescopes: ObservingTelescope[];
  session?: PlatformSession;
};

export const fallbackTelescopes: ObservingTelescope[] = [
  { code: "LT", displayName: "Liverpool Telescope" },
  { code: "NTT", displayName: "New Technology Telescope" },
  { code: "SOAR", displayName: "SOAR Telescope" },
  { code: "VLT", displayName: "Very Large Telescope" },
  { code: "GEMINI_NORTH", displayName: "Gemini North" },
];

export const metrics = [
  { label: "Astronoted objects", value: "0", delta: "0%" },
  { label: "Follow-up objects", value: "10", delta: "+9 today" },
  { label: "Snoozed objects", value: "21", delta: "-4.1%" },
  { label: "Classified today", value: "234", delta: "13k total" },
  { label: "Starred objects", value: "437", delta: "129 shared" },
];

export const health = {
  status: "Operational",
  alertVolume: "42,891",
  processingLag: "1.7 s",
  agnRemovalRate: "31.8%",
  averageConfidence: "0.82",
  lastTrainingDate: "2026-04-18",
};

export const objects: TransientObject[] = [
  {
    id: "needle-001",
    name: "LSST-2026tde-1842",
    lasairId: "LSS_J102429.1+091204",
    ra: "156.1214",
    dec: "+09.2012",
    magnitude: "18.7",
    band: "r",
    lastClassified: "8 min ago",
    classifiedBy: "NEEDLE 2.0",
    classification: "TDE",
    tnsClass: null,
    tnsName: null,
    psImageUrls: ["/stamps/tde-1842-latest.webp"],
    confidence: 0.94,
    classProbabilities: { TDE: 0.94, "SN Ia": 0.03, "SN II": 0.015, Unclear: 0.015, Other: 0.01 },
    comment: "Host match looks clean; no obvious AGN history in the quick-look checks.",
    comments: [
      {
        id: "comment-001",
        publisher: "A. Rivera",
        body: "Please prioritize spectroscopy while the source is still blue and rising.",
        createdAt: "2026-05-14T09:20:00Z",
      },
      {
        id: "comment-002",
        publisher: "M. Chen",
        body: "Host match looks clean; no obvious AGN history in the quick-look checks.",
        createdAt: "2026-05-14T10:05:00Z",
      },
    ],
    starred: true,
    promoted: false,
    snoozed: false,
    followUp: "Observing",
    priority: "Low",
    lastActionAt: "2026-05-14T14:32:00.000Z",
    revisitAt: "2026-05-15T10:00:00.000Z",
    telescopeCodes: ["LT"],
    telescopeCode: "LT",
    agnRemoved: false,
    qualityFlags: ["nuclear", "host matched"],
    imageHue: "190deg",
  },
  {
    id: "needle-002",
    name: "LSST-2026sn-0419",
    lasairId: "LSS_J221035.4-011923",
    ra: "332.6478",
    dec: "-01.3231",
    magnitude: "19.4",
    band: "i",
    lastClassified: "22 min ago",
    classifiedBy: "A. Rivera",
    classification: "SN Ia",
    tnsClass: "SN Ia",
    tnsName: "SN 2026abc",
    psImageUrls: ["/stamps/sn-0419-latest.webp"],
    confidence: 0.87,
    classProbabilities: { "SN Ia": 0.87, "SN II": 0.08, "SN Ibc": 0.03, Unclear: 0.015, Other: 0.005 },
    comment: "Likely normal Ia; keep in list but no urgent escalation.",
    comments: [
      {
        id: "comment-003",
        publisher: "A. Rivera",
        body: "Likely normal Ia; keep in list but no urgent escalation.",
        createdAt: "2026-05-14T08:42:00Z",
      },
    ],
    starred: false,
    promoted: false,
    snoozed: false,
    followUp: "To Do",
    priority: "Low",
    lastActionAt: "2026-05-14T14:10:00.000Z",
    revisitAt: null,
    telescopeCodes: [],
    telescopeCode: null,
    agnRemoved: false,
    qualityFlags: ["clean stamp"],
    imageHue: "28deg",
  },
  {
    id: "needle-003",
    name: "LSST-2026slsn-0997",
    lasairId: "LSS_J034402.8-214411",
    ra: "56.0118",
    dec: "-21.7364",
    magnitude: "20.1",
    band: "g",
    lastClassified: "35 min ago",
    classifiedBy: "NEEDLE 2.0",
    classification: "SLSNe-I",
    tnsClass: null,
    tnsName: null,
    psImageUrls: ["/stamps/slsn-0997-latest.webp"],
    confidence: 0.91,
    classProbabilities: { "SLSNe-I": 0.91, TDE: 0.05, "SN II": 0.025, Unclear: 0.01, Other: 0.005 },
    comment: "High SLSN probability driven by blue color evolution and faint host.",
    comments: [
      {
        id: "comment-004",
        publisher: "NEEDLE 2.0",
        body: "High SLSN probability driven by blue color evolution and faint host.",
        createdAt: "2026-05-14T07:57:00Z",
      },
    ],
    starred: true,
    promoted: true,
    snoozed: false,
    followUp: "Completed",
    priority: "Low",
    lastActionAt: "2026-05-14T13:55:00.000Z",
    revisitAt: null,
    telescopeCodes: ["VLT", "LT"],
    telescopeCode: "VLT",
    agnRemoved: false,
    qualityFlags: ["faint host", "blue color"],
    imageHue: "265deg",
  },
  {
    id: "needle-004",
    name: "LSST-2026agn-3301",
    lasairId: "LSS_J145924.2+372142",
    ra: "224.8510",
    dec: "+37.3618",
    magnitude: "18.9",
    band: "r",
    lastClassified: "1 hr ago",
    classifiedBy: "NEEDLE 2.0",
    classification: "AGN-removed",
    tnsClass: "AGN",
    tnsName: "AT 2026agn",
    psImageUrls: ["/stamps/agn-3301-latest.webp"],
    confidence: 0.96,
    classProbabilities: { "AGN-removed": 0.96, Other: 0.02, Unclear: 0.015, "SN Ia": 0.005 },
    comment: "",
    comments: [],
    starred: false,
    promoted: false,
    snoozed: true,
    followUp: "Snooze",
    priority: "Low",
    lastActionAt: "2026-05-14T13:40:00.000Z",
    revisitAt: null,
    telescopeCodes: [],
    telescopeCode: null,
    agnRemoved: true,
    qualityFlags: ["WISE AGN", "historical variability"],
    imageHue: "320deg",
  },
  {
    id: "needle-005",
    name: "LSST-2026unc-7812",
    lasairId: "LSS_J011449.7+153002",
    ra: "18.7072",
    dec: "+15.5006",
    magnitude: "21.0",
    band: "z",
    lastClassified: "2 hrs ago",
    classifiedBy: "M. Chen",
    classification: "Unclear",
    tnsClass: null,
    tnsName: null,
    psImageUrls: ["/stamps/unc-7812-latest.webp"],
    confidence: 0.52,
    classProbabilities: { Unclear: 0.52, "SN II": 0.24, "SN Ia": 0.15, TDE: 0.06, Other: 0.03 },
    comment: "",
    comments: [],
    starred: false,
    promoted: false,
    snoozed: true,
    followUp: "To Do",
    priority: "Low",
    lastActionAt: "2026-05-14T13:25:00.000Z",
    revisitAt: null,
    telescopeCodes: [],
    telescopeCode: null,
    agnRemoved: false,
    qualityFlags: ["low SNR", "moon proximity"],
    imageHue: "210deg",
  },
];

const simulatedClasses: ObjectClass[] = ["TDE", "SLSNe-I", "SN Ia", "SN Ibc", "SN II", "Unclear", "Other"];
const simulatedBands = ["g", "r", "i", "z"];

for (let index = 6; index <= 20; index += 1) {
  const classification = simulatedClasses[index % simulatedClasses.length];
  const confidence = Number((0.56 + ((index * 7) % 39) / 100).toFixed(2));
  const followUp: FollowUpStatus = index % 6 === 0 ? "Observing" : index % 5 === 0 ? "Completed" : "To Do";

  objects.push({
    id: `needle-${String(index).padStart(3, "0")}`,
    name: `LSST-2026sim-${String(index).padStart(4, "0")}`,
    lasairId: `LSS_SIM_J${String(100000 + index * 137)}.${index % 10}+${String(1000 + index * 29)}`,
    ra: (12.5 + index * 13.271).toFixed(4),
    dec: `${index % 2 === 0 ? "+" : "-"}${(1.4 + index * 2.117).toFixed(4)}`,
    magnitude: (17.8 + (index % 9) * 0.37).toFixed(1),
    band: simulatedBands[index % simulatedBands.length],
    lastClassified: `${index * 11} min ago`,
    classifiedBy: index % 3 === 0 ? "A. Rivera" : "NEEDLE 2.0",
    classification,
    tnsClass: index % 4 === 0 ? classification : null,
    tnsName: index % 4 === 0 ? `AT 2026sim${String(index).padStart(4, "0")}` : null,
    psImageUrls: [`/stamps/lsst-2026sim-${String(index).padStart(4, "0")}-latest.webp`],
    confidence,
    classProbabilities: (() => {
      const rest = 1 - confidence;
      const distribution: Record<string, number> = { [classification]: confidence };
      const fillerClasses: ObjectClass[] = ["TDE", "SLSNe-I", "SN Ia", "SN Ibc", "SN II", "Unclear", "Other"];
      const weights = [0.34, 0.26, 0.2, 0.14];
      let weightIndex = 0;

      for (const cls of fillerClasses) {
        if (cls === classification || weightIndex >= weights.length) {
          continue;
        }

        distribution[cls] = Number(
          Math.max(0.02, rest * weights[weightIndex] + ((index + weightIndex) % 5) * 0.004).toFixed(2),
        );
        weightIndex += 1;
      }

      return distribution;
    })(),
    comment: `Simulated comment for ${classification} workflow review.`,
    comments: [
      {
        id: `comment-sim-${index}`,
        publisher: index % 3 === 0 ? "X. Sheng" : "NEEDLE 2.0",
        body: `Simulated comment for ${classification} workflow review.`,
        createdAt: new Date(Date.now() - index * 17 * 60_000).toISOString(),
      },
    ],
    starred: index % 7 === 0,
    promoted: index % 8 === 0,
    snoozed: index % 10 === 0,
    followUp,
    priority: "Low",
    lastActionAt: new Date(Date.UTC(2026, 4, 14, 8, 30, index * 97)).toISOString(),
    revisitAt: index % 11 === 0 ? new Date(Date.UTC(2026, 4, 16, 12, 0, index)).toISOString() : null,
    telescopeCodes: index % 7 === 0 ? ["SOAR"] : [],
    telescopeCode: index % 7 === 0 ? "SOAR" : null,
    agnRemoved: classification === "AGN-removed",
    qualityFlags: index % 4 === 0 ? ["clean stamp", "host matched"] : ["simulated"],
    imageHue: `${(index * 37) % 360}deg`,
  });
}

export const chartDays = [
  { day: "Apr 24", tde: 18, slsn: 9, sn: 184, unclear: 61, agn: 112, confidence: 78 },
  { day: "Apr 25", tde: 23, slsn: 12, sn: 201, unclear: 54, agn: 128, confidence: 81 },
  { day: "Apr 26", tde: 16, slsn: 10, sn: 193, unclear: 47, agn: 119, confidence: 83 },
  { day: "Apr 27", tde: 28, slsn: 15, sn: 226, unclear: 73, agn: 147, confidence: 80 },
  { day: "Apr 28", tde: 31, slsn: 18, sn: 241, unclear: 68, agn: 158, confidence: 84 },
  { day: "Apr 29", tde: 26, slsn: 14, sn: 219, unclear: 51, agn: 139, confidence: 85 },
  { day: "Apr 30", tde: 34, slsn: 21, sn: 253, unclear: 64, agn: 162, confidence: 86 },
];

export const activity = objects.slice(0, 4).map((object) => ({
  title: object.name,
  meta: `${object.classification} | confidence ${Math.round(object.confidence * 100)}%`,
  time: object.lastClassified,
}));

export const teams = [
  { name: "Transient Hunters", members: 18, collections: 7, permission: "Annotate + classify" },
  { name: "TDE Follow-up", members: 9, collections: 3, permission: "View + annotate" },
  { name: "SLSN Watch", members: 12, collections: 5, permission: "View only" },
];

export const auditEvents = [
  "A. Rivera exported daily TDE candidate report",
  "NEEDLE 2.0 retraining job scheduled for May 03",
  "M. Chen invited orcid:0000-0002-1825-0097 to TDE Follow-up",
  "System rotated refresh tokens for inactive sessions",
];

export const annotations: AnnotationSummary[] = [
  {
    author: "X. Sheng",
    body: "@TDE Follow-up please review the host offset and spectroscopy window before tomorrow's queue.",
  },
  {
    author: "NEEDLE 2.0",
    body: "Classification confidence increased from 0.88 to 0.94 after latest r-band point.",
  },
];

export const fallbackPlatformData: PlatformData = {
  objects,
  metrics,
  chartDays,
  teams,
  auditEvents,
  annotations,
  telescopes: fallbackTelescopes,
  session: { canEditStarred: true },
};
