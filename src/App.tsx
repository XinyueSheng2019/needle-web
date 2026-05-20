import {
  fallbackPlatformData,
  type DailyClassification,
  type FollowUpStatus,
  health,
  type ObjectClass,
  type ObjectComment,
  type ObservingTelescope,
  type PhotometryPoint,
  type PlatformData,
  type TransientObject,
} from "./data";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  fetchObjectDetail,
  fetchPlatformData,
  normalizeTransientObject,
  postObjectComment,
  postObservingTelescope,
  updateObjectInteraction,
  type ObjectInteractionUpdate,
} from "./api";
import { TelescopeVisibilityPanel } from "./TelescopeVisibilityPanel";

const navigation = [
  { label: "Dashboard", id: "dashboard" },
  { label: "Object List", id: "object-list" },
  { label: "Follow-ups", id: "follow-up-queue" },
] as const;

type PageId = (typeof navigation)[number]["id"] | "object-detail" | "admin";

const pageIds: PageId[] = [...navigation.map((item) => item.id), "object-detail", "admin"];

/**
 * Parses `#page` and optional `?lasairId=` for object detail deep links.
 * Object List links use `#object-detail?lasairId=<id>` so the detail page loads that row’s comments.
 */
function parseLocationHash(): { page: PageId; detailLasairId: string | null } {
  const raw = window.location.hash.replace(/^#/, "");
  const queryIndex = raw.indexOf("?");
  const pageToken = (queryIndex >= 0 ? raw.slice(0, queryIndex) : raw).split("&")[0] ?? "";
  const query = queryIndex >= 0 ? raw.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);
  const lasairId = params.get("lasairId");
  const page = pageToken as PageId;

  if (pageIds.includes(page)) {
    return { page, detailLasairId: lasairId };
  }

  return { page: "dashboard", detailLasairId: null };
}

const classColor: Record<ObjectClass, string> = {
  TDE: "teal",
  "SLSNe-I": "violet",
  "SN Ia": "amber",
  "SN Ibc": "orange",
  "SN II": "rose",
  Unclear: "slate",
  "AGN-removed": "red",
  Other: "blue",
};

type InteractionHandler = (object: TransientObject, update: ObjectInteractionUpdate) => void;
type CommentPostHandler = (object: TransientObject, body: string) => Promise<ObjectComment>;
type ActionIconName = "star" | "clock" | "flag" | "promote" | "menu" | "telescope";
type ObjectTagFilter = "starred" | "promoted" | "follow-up";
type ObjectSortField = "lastClassified" | "magnitude" | "classification";
type SortDirection = "asc" | "desc";
type SnoozeRedoState = {
  object: TransientObject;
  index: number;
  exiting: boolean;
};

/** Next follow-up step when using the row action (cycles stages; Snooze is off the kanban but still reachable from the list). */
const FOLLOW_UP_CYCLE: Record<FollowUpStatus, FollowUpStatus> = {
  Snooze: "To Do",
  "To Do": "Observing",
  Observing: "Completed",
  Completed: "Snooze",
};

function isFollowUpTagActive(object: TransientObject) {
  return object.followUp === "To Do" || object.followUp === "Observing" || object.followUp === "Completed";
}

/** Objects shown on the Follow-up Queue board: the three active workflow lanes only (not Snooze). */
function isOnFollowUpBoard(object: TransientObject) {
  return isFollowUpTagActive(object);
}

/**
 * Checks whether an object matches the global search text.
 * To search more fields manually, add them to the `searchableText` array.
 */
function objectMatchesSearch(object: TransientObject, searchTerm: string) {
  const normalizedSearch = searchTerm.trim().toLowerCase();

  if (!normalizedSearch) {
    return true;
  }

  const searchableText = [
    object.name,
    object.lasairId,
    object.ra,
    object.dec,
    object.magnitude,
    object.band,
    object.classification,
    object.tnsClass ?? "",
    object.followUp,
    object.priority,
    object.classifiedBy,
    object.comment,
    object.comments.map((commentEntry) => commentEntry.body).join(" "),
    object.qualityFlags.join(" "),
    (object.telescopeCodes ?? []).join(" "),
    object.telescopeCode ?? "",
  ].join(" ");

  return searchableText.toLowerCase().includes(normalizedSearch);
}

/**
 * Checks whether an object matches the selected Object List tag.
 * The follow-up tag matches objects in an active workflow stage (To Do, Observing, or Completed), not Snooze.
 */
function objectMatchesTag(object: TransientObject, tagFilter: ObjectTagFilter | null) {
  if (!tagFilter) {
    return true;
  }

  if (tagFilter === "starred") {
    return object.starred;
  }

  if (tagFilter === "promoted") {
    return object.promoted;
  }

  return isFollowUpTagActive(object);
}

/**
 * Converts relative or absolute classification timestamps into sortable numbers.
 * To support a new time display manually, add another string pattern here.
 */
function parseLastClassified(lastClassified: string) {
  const parsedDate = Date.parse(lastClassified);

  if (!Number.isNaN(parsedDate)) {
    return parsedDate;
  }

  const relativeMatch = lastClassified.match(/(\d+)\s*(min|mins|hr|hrs|hour|hours)/i);

  if (!relativeMatch) {
    return 0;
  }

  const value = Number(relativeMatch[1]);
  const unit = relativeMatch[2].toLowerCase();
  const minutesAgo = unit.startsWith("h") ? value * 60 : value;

  return Date.now() - minutesAgo * 60_000;
}

/** Sort key: High (4) → Medium (3) → Low (2) → Monitor (1) for kanban ordering within each lane. */
function followUpPriorityRank(p: TransientObject["priority"]): number {
  if (p === "High") {
    return 4;
  }
  if (p === "Medium") {
    return 3;
  }
  if (p === "Low") {
    return 2;
  }
  if (p === "Monitor") {
    return 1;
  }
  return 0;
}

/** Order cards by priority (High first), then by most recent queue/classification touch. */
function compareKanbanCardsInLane(a: TransientObject, b: TransientObject): number {
  const byPriority = followUpPriorityRank(b.priority) - followUpPriorityRank(a.priority);
  if (byPriority !== 0) {
    return byPriority;
  }
  return getObjectActionSortTime(b) - getObjectActionSortTime(a);
}

type LaneOrderRef = MutableRefObject<Partial<Record<FollowUpStatus, string[]>>>;

/**
 * Keeps kanban card order stable when object data changes (e.g. priority).
 * Order is established from priority sort on first paint per lane; new cards (e.g. after drag) append sorted; full re-sort only on page refresh.
 */
function orderKanbanLaneStable(lane: FollowUpStatus, inLane: TransientObject[], orderRef: LaneOrderRef): TransientObject[] {
  const ids = new Set(inLane.map((o) => o.lasairId));
  const byId = new Map(inLane.map((o) => [o.lasairId, o]));
  const prev = orderRef.current[lane];

  if (!prev?.length) {
    const sorted = [...inLane].sort(compareKanbanCardsInLane);
    orderRef.current[lane] = sorted.map((o) => o.lasairId);
    return sorted;
  }

  const kept = prev.filter((id) => ids.has(id));
  const newIds = [...ids].filter((id) => !kept.includes(id));
  const newcomers = newIds.map((id) => byId.get(id)).filter(Boolean) as TransientObject[];
  newcomers.sort(compareKanbanCardsInLane);
  const nextOrder = [...kept, ...newcomers.map((o) => o.lasairId)];
  orderRef.current[lane] = nextOrder;
  return nextOrder.map((id) => byId.get(id)).filter(Boolean) as TransientObject[];
}

/** Sort key for Follow-up Queue tie-break: last user/follow-up/classification touch, then detection time. */
function getObjectActionSortTime(object: TransientObject) {
  const fromAction = Date.parse(object.lastActionAt);
  if (!Number.isNaN(fromAction)) {
    return fromAction;
  }
  return parseLastClassified(object.lastClassified);
}

/**
 * Formats the Last Classified cell as relative age plus calendar date.
 * To change the display manually, edit the thresholds or `toLocaleDateString` options here.
 */
function formatLastClassified(lastClassified: string) {
  const timestamp = parseLastClassified(lastClassified);

  if (!timestamp) {
    return {
      relative: "unknown",
      date: "No date",
    };
  }

  const elapsedMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  const classifiedDate = new Date(timestamp).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  if (elapsedMinutes < 60) {
    return {
      relative: `${elapsedMinutes || 1} min ago`,
      date: classifiedDate,
    };
  }

  if (elapsedMinutes < 60 * 24) {
    return {
      relative: `${Math.round(elapsedMinutes / 60)} hr ago`,
      date: classifiedDate,
    };
  }

  return {
    relative: `${Math.round(elapsedMinutes / (60 * 24))} days ago`,
    date: classifiedDate,
  };
}

/** `<select>` value: open the inline form for a new facility (added with "Add to card"). */
const KANBAN_ADD_TELESCOPE_SELECT_VALUE = "__kanban_add_telescope__";

const LC_BAND_COLORS: Record<string, string> = {
  g: "#4ade80",
  r: "#f87171",
  i: "#fb923c",
  z: "#c084fc",
  u: "#38bdf8",
  y: "#fbbf24",
  default: "#94a3b8",
};

function objectRaDecDegrees(object: TransientObject): { ra: number; dec: number } {
  const ra = parseFloat(object.ra);
  const dec = parseFloat(String(object.dec).replace(/^\+/, ""));
  return { ra, dec: Number.isFinite(dec) ? dec : 0 };
}

function buildAladinLiteUrl(object: TransientObject): string {
  const { ra, dec } = objectRaDecDegrees(object);
  const decStr = dec >= 0 ? `+${dec}` : String(dec);
  const target = `${ra} ${decStr}`;
  const survey = encodeURIComponent("CDS/P/DSS2/color");
  const fov = 0.12;
  const addCatalog = false;
  const addTool = false;
  const width = 1000;
  const height = 1000;
  const saveImage = false;


  return `https://aladin.cds.unistra.fr/AladinLite/?target=${encodeURIComponent(target)}&fov=${fov}&survey=${survey}&addCatalog=${addCatalog}&addTool=${addTool}&width=${width}&height=${height}&saveImage=${saveImage}`;
}

function syntheticPhotometry(object: TransientObject): PhotometryPoint[] {
  const m = parseFloat(object.magnitude);
  const mag = Number.isFinite(m) ? m : 20;
  const base = 60775;
  const bands = ["g", "r", "i"];
  const pts: PhotometryPoint[] = [];
  for (let d = 0; d < 6; d += 1) {
    for (let b = 0; b < bands.length; b += 1) {
      pts.push({
        mjd: base + d + b * 0.02,
        band: bands[b],
        mag: mag - d * 0.08 + b * 0.12 + ((d + b) % 3) * 0.03,
        magErr: 0.04,
      });
    }
  }
  return pts;
}

/** UTC calendar day (YYYY-MM-DD) for an MJD instant; ties photometry detections to daily NEEDLE snapshots. */
function mjdToUtcCalendarDay(mjd: number): string {
  const ms = (mjd - 40587) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Stable key for one photometry detection (one point on the light curve). */
function detectionClassificationKey(point: PhotometryPoint): string {
  return `${point.mjd}:${String(point.band || "?").toLowerCase()}`;
}

const PER_DETECTION_PRIOR_CLASSES: ObjectClass[] = [
  "TDE",
  "SLSNe-I",
  "SN Ia",
  "SN Ibc",
  "SN II",
  "Unclear",
  "AGN-removed",
  "Other",
];

function detHashU01(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffff_ffff;
}

/** d(mag)/d(MJD) using neighbors in the same band (fewer points → single-sided). */
function bandNeighborhoodSlope(point: PhotometryPoint, photometry: PhotometryPoint[]): number {
  const b = String(point.band || "?").toLowerCase();
  const series = photometry
    .filter((p) => String(p.band || "?").toLowerCase() === b && Number.isFinite(p.mag) && Number.isFinite(p.mjd))
    .sort((a, c) => a.mjd - c.mjd);
  const ix = series.findIndex(
    (p) => p.mjd === point.mjd && String(p.band || "?").toLowerCase() === b,
  );
  if (ix < 0 || series.length < 2) {
    return 0;
  }
  const prev = series[ix - 1];
  const next = series[ix + 1];
  if (prev && next) {
    return (next.mag - prev.mag) / (next.mjd - prev.mjd);
  }
  if (next) {
    return (next.mag - point.mag) / (next.mjd - point.mjd);
  }
  if (prev) {
    return (point.mag - prev.mag) / (point.mjd - prev.mjd);
  }
  return 0;
}

/**
 * NEEDLE-style class probabilities for a single detection: priors from the DB snapshot of that UTC day
 * (if any) or from the object row, then perturbed deterministically from magnitude, band, and local slope.
 */
function classificationForDetection(
  point: PhotometryPoint,
  photometry: PhotometryPoint[],
  object: TransientObject,
  dataSource: "database" | "fallback",
  apiByDay: Map<string, DailyClassification>,
): DailyClassification {
  const day = mjdToUtcCalendarDay(point.mjd);
  const api = apiByDay.get(day);
  const eps = 1e-4;
  const priors: Record<string, number> = {};

  let modelVersion: string;
  let classifiedAtIso: string;

  if (dataSource === "database" && api) {
    for (const c of PER_DETECTION_PRIOR_CLASSES) {
      const v = api.rawProbs[c];
      priors[c] = typeof v === "number" && v > 0 ? v : eps;
    }
    const sumP = PER_DETECTION_PRIOR_CLASSES.reduce((acc, c) => acc + priors[c], 0);
    if (sumP < 1e-6) {
      for (const c of PER_DETECTION_PRIOR_CLASSES) {
        priors[c] = (object.classProbabilities[c] ?? 0) + eps;
      }
    }
    modelVersion = api.modelVersion?.trim() ? api.modelVersion : "NEEDLE 2.0";
    classifiedAtIso = api.classifiedAt;
  } else {
    for (const c of PER_DETECTION_PRIOR_CLASSES) {
      priors[c] = (object.classProbabilities[c] ?? 0) + eps;
    }
    const s = PER_DETECTION_PRIOR_CLASSES.reduce((acc, c) => acc + priors[c], 0);
    if (s < 1e-6) {
      const u = 1 / PER_DETECTION_PRIOR_CLASSES.length;
      for (const c of PER_DETECTION_PRIOR_CLASSES) {
        priors[c] = u;
      }
    }
    modelVersion = object.classifiedBy?.trim() ? object.classifiedBy : "NEEDLE 2.0";
    classifiedAtIso = `${day}T12:00:00.000Z`;
  }

  const slope = bandNeighborhoodSlope(point, photometry);
  const brighten = -slope;
  const mags = photometry.map((p) => p.mag).filter(Number.isFinite);
  const minM = mags.length ? Math.min(...mags) : Number(point.mag);
  const maxM = mags.length ? Math.max(...mags) : Number(point.mag);
  const magSpan = maxM - minM || 1;
  const magN = (Number(point.mag) - minM) / magSpan;

  const weights: Record<string, number> = {};
  for (const c of PER_DETECTION_PRIOR_CLASSES) {
    let w = priors[c];
    const hDet = 0.52 + 0.96 * detHashU01(`${point.mjd.toFixed(5)}|${point.band}|${c}|x`);
    const hMag = 0.82 + 0.36 * (1 - magN);
    let slopeBias = 1;
    if (c === "TDE") {
      slopeBias *= 1 + 0.14 * Math.max(0, brighten);
    }
    if (c === "SLSNe-I") {
      slopeBias *= 1 + 0.1 * Math.max(0, brighten);
    }
    if (c === "SN Ia") {
      slopeBias *= 1 + 0.06 / (1 + Math.abs(brighten));
    }
    if (c === "AGN-removed") {
      slopeBias *= 1 + 0.05 * Math.max(0, magN - 0.55);
    }
    w *= hDet * hMag * slopeBias;
    weights[c] = w;
  }

  let sumW = PER_DETECTION_PRIOR_CLASSES.reduce((acc, c) => acc + weights[c], 0);
  if (sumW <= 0) {
    sumW = 1;
  }
  const rawProbs: Record<string, number> = {};
  let top: ObjectClass = "Unclear";
  let best = -1;
  for (const c of PER_DETECTION_PRIOR_CLASSES) {
    const p = weights[c] / sumW;
    rawProbs[c] = p;
    if (p > best) {
      best = p;
      top = c;
    }
  }

  return {
    day,
    classifiedAt: classifiedAtIso,
    class: top,
    confidence: best,
    rawProbs,
    modelVersion: `${modelVersion} · per-detection view`,
  };
}

function buildClassificationByDetection(
  photometry: PhotometryPoint[],
  object: TransientObject,
  dataSource: "database" | "fallback",
  apiHistory: DailyClassification[],
): Map<string, DailyClassification> {
  const map = new Map<string, DailyClassification>();
  const apiByDay = new Map<string, DailyClassification>();
  for (const row of apiHistory) {
    apiByDay.set(row.day, row);
  }
  for (const p of photometry) {
    map.set(
      detectionClassificationKey(p),
      classificationForDetection(p, photometry, object, dataSource, apiByDay),
    );
  }
  return map;
}

function kanbanTelescopeLabel(code: string, catalog: ObservingTelescope[]) {
  const found =
    catalog.find((entry) => entry.code === code) ??
    catalog.find((entry) => entry.code.toLowerCase() === code.toLowerCase());
  return found?.displayName ?? code;
}

/** Latest comment for kanban cards: prefer thread head (author + time); else API preview body only. */
type LatestCardComment = { body: string; publisher: string | null; createdAt: string | null };

function latestCommentForCard(object: TransientObject): LatestCardComment | null {
  const thread = object.comments[0];
  if (thread?.body?.trim()) {
    return {
      body: thread.body.trim(),
      publisher: thread.publisher?.trim() || null,
      createdAt: thread.createdAt || null,
    };
  }
  const preview = object.comment?.trim();
  if (preview) {
    return { body: preview, publisher: null, createdAt: null };
  }
  return null;
}

/** Build a drag bitmap with a fixed pixel width — the live card uses `width: 100%`, which resolves wrong when captured outside the lane grid. */
function mountKanbanDragPreview(source: HTMLElement, event: DragEvent<HTMLElement>): HTMLElement {
  const rect = source.getBoundingClientRect();
  const clone = source.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLDetailsElement>("details").forEach((detailsElement) => {
    detailsElement.open = false;
  });
  clone.classList.add("task-card--drag-preview");
  Object.assign(clone.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${Math.round(rect.width)}px`,
    maxWidth: `${Math.round(rect.width)}px`,
    boxSizing: "border-box",
    pointerEvents: "none",
    margin: "0",
    zIndex: "2147483647",
  });
  document.body.appendChild(clone);
  void clone.offsetWidth;
  const offsetX = Math.round(event.clientX - rect.left);
  const offsetY = Math.round(event.clientY - rect.top);
  event.dataTransfer.setDragImage(clone, offsetX, offsetY);
  return clone;
}

/** Follow-up board column title (PostgreSQL / API still use `Completed`). */
function followUpQueueLaneLabel(lane: FollowUpStatus): string {
  if (lane === "Completed") {
    return "Completed";
  }
  return lane;
}

/** Local date (yyyy-mm-dd) and time (HH:mm) from a stored ISO timestamp (for editing). */
function splitRevisitLocal(iso: string | null): { date: string; time: string } {
  if (!iso) {
    return { date: "", time: "" };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { date: "", time: "" };
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Default revisit when none is set: calendar date of open + 7 days, 10:00 local. */
function defaultRevisitPlusSevenLocal(): { date: string; time: string } {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(10, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function closeKanbanDetails(element: HTMLElement) {
  const details = element.closest("details");
  if (details) {
    details.open = false;
  }
}

/** True if click should not fold this open kanban tool (inside details or on matching readout row). */
function shouldKeepKanbanToolOpen(menu: HTMLDetailsElement, target: Node): boolean {
  if (menu.contains(target)) {
    return true;
  }
  const element = target instanceof Element ? target : target.parentElement;
  if (!element) {
    return false;
  }
  const tool = menu.dataset.kanbanTool;
  if (tool !== "revisit" && tool !== "telescope") {
    return false;
  }
  const readout = element.closest(`[data-kanban-readout="${tool}"]`);
  if (!readout) {
    return false;
  }
  const card = menu.closest(".task-card");
  return Boolean(card && card.contains(readout));
}

/** When one kanban tool popover opens, fold the others on the same card. */
function closeSiblingKanbanToolMenus(openedDetails: HTMLDetailsElement) {
  const tools = openedDetails.closest(".kanban-card-tools");
  if (!tools) {
    return;
  }
  tools.querySelectorAll<HTMLDetailsElement>("details.kanban-tool[open]").forEach((element) => {
    if (element !== openedDetails) {
      element.open = false;
    }
  });
}

function formatRevisitHint(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/**
 * Formats comment timestamps for display in Object Detail.
 * To show full timestamps manually, include hour/minute options in `toLocaleString`.
 */
function formatCommentTime(timestamp: string) {
  const parsedTimestamp = Date.parse(timestamp);

  if (Number.isNaN(parsedTimestamp)) {
    return timestamp;
  }

  return new Date(parsedTimestamp).toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Returns a sortable primitive for the selected Object List sort field.
 * To add another sort option manually, extend `ObjectSortField`, this switch, and the select control.
 */
function getObjectSortValue(object: TransientObject, sortField: ObjectSortField) {
  if (sortField === "lastClassified") {
    return parseLastClassified(object.lastClassified);
  }

  if (sortField === "magnitude") {
    return Number(object.magnitude);
  }

  return object.classification;
}

/**
 * Sorts objects by the selected field and direction.
 * To change default tie-breaking manually, edit the final `name.localeCompare` fallback.
 */
function sortObjects(objects: TransientObject[], sortField: ObjectSortField, sortDirection: SortDirection) {
  const directionMultiplier = sortDirection === "asc" ? 1 : -1;

  return [...objects].sort((firstObject, secondObject) => {
    const firstValue = getObjectSortValue(firstObject, sortField);
    const secondValue = getObjectSortValue(secondObject, sortField);

    if (typeof firstValue === "string" && typeof secondValue === "string") {
      const comparison = firstValue.localeCompare(secondValue);
      return comparison === 0
        ? firstObject.name.localeCompare(secondObject.name)
        : comparison * directionMultiplier;
    }

    const firstNumber = Number.isFinite(Number(firstValue)) ? Number(firstValue) : Number.POSITIVE_INFINITY;
    const secondNumber = Number.isFinite(Number(secondValue)) ? Number(secondValue) : Number.POSITIVE_INFINITY;
    const comparison = firstNumber - secondNumber;

    return comparison === 0 ? firstObject.name.localeCompare(secondObject.name) : comparison * directionMultiplier;
  });
}

/**
 * Root application shell.
 * It owns page routing, database/fallback data loading, and object action state.
 * To change global behavior manually, edit the state hooks and handlers here first.
 */
function App() {
  const [activePage, setActivePage] = useState<PageId>(() => parseLocationHash().page);
  const [detailLasairId, setDetailLasairId] = useState<string | null>(() => parseLocationHash().detailLasairId);
  const [platformData, setPlatformData] = useState<PlatformData>(fallbackPlatformData);
  const [dataSource, setDataSource] = useState<"database" | "fallback">("fallback");
  const [interactionMessage, setInteractionMessage] = useState("Object actions are ready.");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTagFilter, setActiveTagFilter] = useState<ObjectTagFilter | null>(null);
  const [sortField, setSortField] = useState<ObjectSortField>("lastClassified");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [snoozeRedo, setSnoozeRedo] = useState<SnoozeRedoState | null>(null);
  const snoozeRedoTimerRef = useRef<number | null>(null);
  const accountMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const dismissOverlayMenusOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      const account = accountMenuRef.current;
      if (account?.open && !account.contains(target)) {
        account.open = false;
      }

      document.querySelectorAll<HTMLDetailsElement>("details.row-action-menu[open]").forEach((menu) => {
        if (!menu.contains(target)) {
          menu.open = false;
        }
      });
    };

    const dismissOverlayMenusOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      const account = accountMenuRef.current;
      if (account?.open) {
        account.open = false;
      }

      document.querySelectorAll<HTMLDetailsElement>("details.row-action-menu[open]").forEach((menu) => {
        menu.open = false;
      });
    };

    document.addEventListener("pointerdown", dismissOverlayMenusOnPointerDown, true);
    document.addEventListener("keydown", dismissOverlayMenusOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOverlayMenusOnPointerDown, true);
      document.removeEventListener("keydown", dismissOverlayMenusOnEscape);
    };
  }, []);
  const selectedObject = useMemo(() => {
    const objects = platformData.objects;
    const fallbackObject = fallbackPlatformData.objects[0];

    if (detailLasairId) {
      const match = objects.find((object) => object.lasairId === detailLasairId);
      if (match) {
        return match;
      }
    }

    return objects[0] ?? fallbackObject;
  }, [detailLasairId, platformData.objects]);
  const objectListObjects = useMemo(
    () => {
      const filteredObjects = platformData.objects.filter((object) => {
        const matchesSearch = objectMatchesSearch(object, searchTerm);
        const matchesTag = objectMatchesTag(object, activeTagFilter);
        return searchTerm.trim() ? matchesSearch && matchesTag : !object.snoozed && matchesTag;
      });

      return sortObjects(filteredObjects, sortField, sortDirection);
    },
    [activeTagFilter, platformData.objects, searchTerm, sortDirection, sortField],
  );

  useEffect(() => {
    const handleHashChange = () => {
      const { page, detailLasairId: nextDetailId } = parseLocationHash();
      setActivePage(page);
      setDetailLasairId(nextDetailId);
    };

    handleHashChange();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    fetchPlatformData().then(({ data, source }) => {
      setPlatformData(data);
      setDataSource(source);
    });
  }, []);

  const canEditStarred = platformData.session?.canEditStarred ?? true;

  useEffect(() => {
    if (!canEditStarred && activeTagFilter === "starred") {
      setActiveTagFilter(null);
    }
  }, [canEditStarred, activeTagFilter]);

  /**
   * Replaces one object in the current frontend state after the API returns a saved record.
   * To change matching behavior manually, replace `lasairId` with another stable object key.
   */
  const replaceObject = (lasairId: string, updatedObject: TransientObject) => {
    setPlatformData((current) => ({
      ...current,
      objects: current.objects.map((object) =>
        object.lasairId === lasairId ? normalizeTransientObject({ ...object, ...updatedObject }) : object,
      ),
    }));
  };

  /**
   * Applies a partial local update to one object for optimistic UI feedback.
   * To add more object fields manually, pass them in the `update` object.
   */
  const patchObject = (lasairId: string, update: Partial<TransientObject>) => {
    setPlatformData((current) => ({
      ...current,
      objects: current.objects.map((object) => (object.lasairId === lasairId ? { ...object, ...update } : object)),
    }));
  };

  /**
   * Adds a posted comment to one object in the shared frontend state.
   * This keeps the Object Detail comments and Object List preview in sync.
   */
  const addObjectComment = (lasairId: string, comment: ObjectComment) => {
    setPlatformData((current) => ({
      ...current,
      objects: current.objects.map((object) =>
        object.lasairId === lasairId
          ? {
              ...object,
              comment: comment.body,
              comments: [comment, ...object.comments],
            }
          : object,
      ),
    }));
  };

  /**
   * Clears the temporary redo prompt shown after a snooze action.
   * To change the prompt timing manually, update the timeout duration in `showSnoozeRedo`.
   */
  const clearSnoozeRedo = () => {
    if (snoozeRedoTimerRef.current) {
      window.clearTimeout(snoozeRedoTimerRef.current);
      snoozeRedoTimerRef.current = null;
    }

    setSnoozeRedo(null);
  };

  /**
   * Shows a short-lived redo option after an object is snoozed and removed from the list.
   * To keep the option visible longer manually, change `6000` to another number of milliseconds.
   */
  const showSnoozeRedo = (object: TransientObject, index: number) => {
    clearSnoozeRedo();
    setSnoozeRedo({ object, index: Math.max(index, 0), exiting: false });
    snoozeRedoTimerRef.current = window.setTimeout(() => {
      setSnoozeRedo((current) => (current ? { ...current, exiting: true } : current));
      snoozeRedoTimerRef.current = window.setTimeout(() => {
        setSnoozeRedo(null);
        snoozeRedoTimerRef.current = null;
      }, 360);
    }, 6000);
  };

  useEffect(() => {
    return () => {
      if (snoozeRedoTimerRef.current) {
        window.clearTimeout(snoozeRedoTimerRef.current);
      }
    };
  }, []);

  /**
   * Handles Star, Snooze, and Follow-up actions.
   * It updates the UI immediately, then persists to PostgreSQL when the API is connected.
   * To add a new button action manually, extend `ObjectInteractionUpdate` and map it here.
   */
  const handleObjectInteraction: InteractionHandler = async (object, update) => {
    if (update.starred !== undefined && !canEditStarred) {
      setInteractionMessage("Starred is only editable for private workspace accounts.");
      return;
    }

    const previousObject = object;
    const previousObjectIndex = objectListObjects.findIndex((candidate) => candidate.lasairId === object.lasairId);
    const optimisticUpdate: Partial<TransientObject> = {};

    if (update.starred !== undefined) {
      optimisticUpdate.starred = update.starred;
    }

    if (update.promoted !== undefined) {
      optimisticUpdate.promoted = update.promoted;
    }

    if (update.snoozed !== undefined) {
      optimisticUpdate.snoozed = update.snoozed;
    }

    if (update.followUp !== undefined) {
      optimisticUpdate.followUp = update.followUp;
    }

    if (update.priority !== undefined) {
      optimisticUpdate.priority = update.priority;
    } else if (update.followUp === "Completed") {
      optimisticUpdate.priority = "Low";
    }

    if (update.revisitAt !== undefined) {
      optimisticUpdate.revisitAt = update.revisitAt;
    }

    if (update.telescopeCodes !== undefined) {
      const codes = [
        ...new Set(update.telescopeCodes.map((c) => String(c).trim().replace(/\s+/g, "_")).filter(Boolean)),
      ];
      optimisticUpdate.telescopeCodes = codes;
      optimisticUpdate.telescopeCode = codes[0] ?? null;
    }

    if (update.telescope !== undefined) {
      if (update.telescope === null || update.telescope === "") {
        optimisticUpdate.telescopeCodes = [];
        optimisticUpdate.telescopeCode = null;
      } else {
        const one = String(update.telescope).trim().replace(/\s+/g, "_");
        optimisticUpdate.telescopeCodes = one ? [one] : [];
        optimisticUpdate.telescopeCode = one || null;
      }
    }

    if (
      update.starred !== undefined ||
      update.promoted !== undefined ||
      update.snoozed !== undefined ||
      update.followUp !== undefined ||
      update.priority !== undefined ||
      update.revisitAt !== undefined ||
      update.telescope !== undefined ||
      update.telescopeCodes !== undefined
    ) {
      optimisticUpdate.lastActionAt = new Date().toISOString();
    }

    patchObject(object.lasairId, optimisticUpdate);

    if (update.snoozed === true) {
      showSnoozeRedo(previousObject, previousObjectIndex);
    } else if (update.snoozed === false) {
      clearSnoozeRedo();
    }

    if (dataSource === "fallback") {
      setInteractionMessage("Updated locally. Start the API to persist changes to PostgreSQL.");
      return;
    }

    try {
      setInteractionMessage(`Saving ${object.name}...`);
      const savedObject = await updateObjectInteraction(object.lasairId, update);
      replaceObject(object.lasairId, savedObject);
      setInteractionMessage(`Saved ${object.name} to PostgreSQL.`);
    } catch (error) {
      replaceObject(object.lasairId, previousObject);
      if (update.snoozed === true) {
        clearSnoozeRedo();
      }
      setInteractionMessage(error instanceof Error ? `Save failed: ${error.message}` : "Save failed.");
    }
  };

  /**
   * Persists a new object comment and updates the Object List preview.
   * If the API is offline, it still adds a local comment so the prototype remains usable.
   */
  const handlePostObjectComment: CommentPostHandler = async (object, body) => {
    if (dataSource === "fallback") {
      const localComment = {
        id: `local-comment-${Date.now()}`,
        publisher: "X. Researcher",
        body,
        createdAt: new Date().toISOString(),
      };

      addObjectComment(object.lasairId, localComment);
      setInteractionMessage("Comment added locally. Start the API to persist comments to PostgreSQL.");
      return localComment;
    }

    const savedComment = await postObjectComment(object.lasairId, body);
    addObjectComment(object.lasairId, savedComment);
    setInteractionMessage(`Saved comment for ${object.name} to PostgreSQL.`);
    return savedComment;
  };

  const handleTelescopeAdded = useCallback((entry: ObservingTelescope) => {
    setPlatformData((current) => ({
      ...current,
      telescopes: [...current.telescopes.filter((t) => t.code !== entry.code), entry].sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
    }));
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <a className="brand" href="#dashboard" onClick={() => setActivePage("dashboard")} aria-label="NEEDLE LSST home">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          <span>
            <strong>NEEDLE</strong>
            <small>LSST classifier</small>
          </span>
        </a>

        <nav className="nav-list">
          {navigation.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={activePage === item.id ? "active" : undefined}
              aria-current={activePage === item.id ? "page" : undefined}
              onClick={() => setActivePage(item.id)}
            >
              <span aria-hidden="true">{item.label.slice(0, 2).toUpperCase()}</span>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="sidebar-card">
          <p>Data Source</p>
          <strong>{dataSource === "database" ? "PostgreSQL" : "Local fallback"}</strong>
          <span>{dataSource === "database" ? "Live API connected" : "Start API for database data"}</span>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <label className="global-search">
            <span>Search objects</span>
            <span className="search-control">
              <input
                value={searchTerm}
                placeholder="Search globally by name, coordinates, class, action, or Lasair ID"
                onChange={(event) => {
                  const nextSearchTerm = event.target.value;
                  setSearchTerm(nextSearchTerm);

                  if (nextSearchTerm.trim()) {
                    setActivePage("object-list");
                  }
                }}
              />
              {searchTerm ? (
                <button
                  type="button"
                  className="clear-search-button"
                  aria-label="Clear global search"
                  onClick={() => setSearchTerm("")}
                >
                  Clear
                </button>
              ) : null}
            </span>
          </label>
          <div className="topbar-actions">
            <details className="account-menu" ref={accountMenuRef}>
              <summary aria-label="Open admin and account menu">
                <span className="avatar" aria-hidden="true">
                  XR
                </span>
                <span>Admin</span>
              </summary>
              <div className="account-menu-panel">
                <a
                  href="#admin"
                  onClick={() => {
                    setActivePage("admin");
                    if (accountMenuRef.current) {
                      accountMenuRef.current.open = false;
                    }
                  }}
                >
                  Admin Console
                </a>
                <a
                  href="#admin"
                  onClick={() => {
                    setActivePage("admin");
                    if (accountMenuRef.current) {
                      accountMenuRef.current.open = false;
                    }
                  }}
                >
                  Account
                </a>
                <a
                  href="#admin"
                  onClick={() => {
                    setActivePage("admin");
                    if (accountMenuRef.current) {
                      accountMenuRef.current.open = false;
                    }
                  }}
                >
                  Sign in / Login
                </a>
                <a
                  href="#admin"
                  onClick={() => {
                    setActivePage("admin");
                    if (accountMenuRef.current) {
                      accountMenuRef.current.open = false;
                    }
                  }}
                >
                  Settings
                </a>
              </div>
            </details>
          </div>
        </header>

        <main className="page-main">
          <p className="interaction-status" role="status">
            {interactionMessage}
          </p>
          <ActivePage
            page={activePage}
            platformData={platformData}
            objectListObjects={objectListObjects}
            searchTerm={searchTerm}
            activeTagFilter={activeTagFilter}
            sortField={sortField}
            sortDirection={sortDirection}
            snoozeRedo={snoozeRedo}
            selectedObject={selectedObject}
            canEditStarred={canEditStarred}
            onInteraction={handleObjectInteraction}
            onPostComment={handlePostObjectComment}
            onTagFilterChange={(tagFilter) => {
              setActiveTagFilter((current) => (current === tagFilter ? null : tagFilter));
              setActivePage("object-list");
            }}
            onSortFieldChange={setSortField}
            onSortDirectionToggle={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
            onRedoSnooze={() => {
              if (snoozeRedo) {
                handleObjectInteraction({ ...snoozeRedo.object, snoozed: true }, { snoozed: false });
              }
            }}
            dataSource={dataSource}
            onTelescopeAdded={handleTelescopeAdded}
          />
        </main>

        <footer className="footer">
          <span>NEEDLE-LSST v0.1.0</span>
          <span>Data credits: Lasair/ Zwicky Transient Facility / Rubin Observatory / Pan-STARRS</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * Chooses which page component to render for the current hash route.
 * To add a new page manually, add a case here and create the matching component below.
 */
function ActivePage({
  page,
  platformData,
  objectListObjects,
  searchTerm,
  activeTagFilter,
  sortField,
  sortDirection,
  snoozeRedo,
  selectedObject,
  canEditStarred,
  onInteraction,
  onPostComment,
  onTagFilterChange,
  onSortFieldChange,
  onSortDirectionToggle,
  onRedoSnooze,
  dataSource,
  onTelescopeAdded,
}: {
  page: PageId;
  platformData: PlatformData;
  objectListObjects: TransientObject[];
  searchTerm: string;
  activeTagFilter: ObjectTagFilter | null;
  sortField: ObjectSortField;
  sortDirection: SortDirection;
  snoozeRedo: SnoozeRedoState | null;
  selectedObject: TransientObject;
  canEditStarred: boolean;
  onInteraction: InteractionHandler;
  onPostComment: CommentPostHandler;
  onTagFilterChange: (tagFilter: ObjectTagFilter) => void;
  onSortFieldChange: (sortField: ObjectSortField) => void;
  onSortDirectionToggle: () => void;
  onRedoSnooze: () => void;
  dataSource: "database" | "fallback";
  onTelescopeAdded: (telescope: ObservingTelescope) => void;
}) {
  switch (page) {
    case "object-list":
      return (
        <ObjectBrowser
          objects={objectListObjects}
          searchTerm={searchTerm}
          activeTagFilter={activeTagFilter}
          sortField={sortField}
          sortDirection={sortDirection}
          snoozeRedo={snoozeRedo}
          canEditStarred={canEditStarred}
          onInteraction={onInteraction}
          onTagFilterChange={onTagFilterChange}
          onSortFieldChange={onSortFieldChange}
          onSortDirectionToggle={onSortDirectionToggle}
          onRedoSnooze={onRedoSnooze}
        />
      );
    case "object-detail":
      return (
        <ObjectDetail
          object={selectedObject}
          onInteraction={onInteraction}
          onPostComment={onPostComment}
          telescopes={platformData.telescopes}
          dataSource={dataSource}
          onTelescopeAdded={onTelescopeAdded}
          canEditStarred={canEditStarred}
        />
      );
    case "follow-up-queue":
      return (
        <FollowUpQueue
          objects={platformData.objects}
          telescopes={platformData.telescopes}
          dataSource={dataSource}
          onInteraction={onInteraction}
          onTelescopeAdded={onTelescopeAdded}
        />
      );
    case "admin":
      return <AdminPanel auditEvents={platformData.auditEvents} />;
    case "dashboard":
    default:
      return (
        <>
          <Hero />
          <MetricsGrid metrics={platformData.metrics} />
          <Dashboard objects={platformData.objects} />
          <Statistics chartDays={platformData.chartDays} />
          <ModelMonitor />
        </>
      );
  }
}

/**
 * Dashboard hero banner with high-level platform actions and LSST alert summary.
 * To edit the landing copy or primary buttons manually, change the text and buttons here.
 */
function Hero() {
  return (
    <section className="hero" id="dashboard">
      <div>
        <p className="eyebrow">Real-time transient intelligence</p>
        <h1>Secure multi-user platform for NEEDLE 2.0 LSST alert triage.</h1>
        <p className="hero-copy">
          Classify new Lasair alerts, remove AGN contaminants, coordinate follow-up, and preserve a full
          research audit trail from one responsive dark-mode workspace.
        </p>
        <div className="hero-actions">
          <button type="button">Classify New Alerts</button>
          <button type="button" className="secondary">
            View Today&apos;s Histogram
          </button>
          <button type="button" className="ghost">
            Export Today&apos;s Report
          </button>
        </div>
      </div>
      <div className="hero-panel" aria-label="Today at a glance">
        <span>Today&apos;s LSST alert volume</span>
        <strong>{health.alertVolume}</strong>
        <p>NEEDLE average confidence {health.averageConfidence}; AGN removal {health.agnRemovalRate}.</p>
      </div>
    </section>
  );
}

/**
 * Displays the key KPI cards loaded from the database or fallback data.
 * To change which metrics appear manually, update the API response or fallback `metrics` array.
 */
function MetricsGrid({ metrics }: { metrics: PlatformData["metrics"] }) {
  return (
    <section className="metric-grid" aria-label="Key metrics">
      {metrics.map((metric) => (
        <article className="metric-card" key={metric.label}>
          <p>{metric.label}</p>
          <strong>{metric.value}</strong>
          <span>{metric.delta}</span>
        </article>
      ))}
    </section>
  );
}

/**
 * Shows recent object activity and NEEDLE model health on the Dashboard.
 * To change recent activity manually, adjust how the `objects` array is sliced and mapped here.
 */
function Dashboard({ objects }: { objects: TransientObject[] }) {
  const activity = objects.slice(0, 4).map((object) => ({
    title: object.name,
    meta: `${object.classification} | confidence ${Math.round(object.confidence * 100)}%`,
    time: object.lastClassified,
  }));

  return (
    <section className="section-grid">
      <Panel title="Recent Activity Feed" eyebrow="Top 10 Recent Classifications">
        <div className="activity-list">
          {activity.map((item) => (
            <div className="activity-item" key={item.title}>
              <ImageStamp hue="190deg" label={item.title} />
              <div>
                <strong>{item.title}</strong>
                <span>{item.meta}</span>
              </div>
              <time>{item.time}</time>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="NEEDLE 2.0 Health" eyebrow="Model operations">
        <div className="health-grid">
          <Status label="AGN removal" value={health.agnRemovalRate} />
          <Status label="Average confidence" value={health.averageConfidence} />
          <Status label="Last training" value={health.lastTrainingDate} />
          <Status label="Alert lag" value={health.processingLag} />
        </div>
      </Panel>
    </section>
  );
}

/**
 * Renders the daily classification histogram.
 * To change chart behavior manually, adjust the `chartDays` data shape or edit the bar mapping here.
 */
function Statistics({ chartDays }: { chartDays: PlatformData["chartDays"] }) {
  const maxTotal = Math.max(...chartDays.map((day) => day.tde + day.slsn + day.sn + day.unclear + day.agn), 1);

  return (
    <Section
      id="statistics"
      eyebrow="Statistics Dashboard"
      title="Daily classification histogram and confidence trends"
      copy="Filter by date range, class, confidence threshold, and team user. The mock chart below mirrors the stacked alert breakdown requested in the design spec."
    >
      <div className="chart-card">
        <div className="chart-toolbar">
          <button type="button">Last 30 days</button>
          <button type="button">Confidence overlay</button>
          <button type="button">Export CSV</button>
          <button type="button">Export PDF</button>
        </div>
        <div className="stacked-chart" role="img" aria-label="Stacked classification counts by day">
          {chartDays.map((day) => {
            const total = day.tde + day.slsn + day.sn + day.unclear + day.agn;
            return (
              <div className="bar-column" key={day.day}>
                <div className="bar-track">
                  <span className="bar tde" style={{ height: `${(day.tde / maxTotal) * 100}%` }} />
                  <span className="bar slsn" style={{ height: `${(day.slsn / maxTotal) * 100}%` }} />
                  <span className="bar sn" style={{ height: `${(day.sn / maxTotal) * 100}%` }} />
                  <span className="bar unclear" style={{ height: `${(day.unclear / maxTotal) * 100}%` }} />
                  <span className="bar agn" style={{ height: `${(day.agn / maxTotal) * 100}%` }} />
                </div>
                <strong>{total}</strong>
                <span>{day.day}</span>
                <small>{day.confidence}%</small>
              </div>
            );
          })}
        </div>
        <div className="legend">
          {["TDE", "SLSNe-I", "SN", "Unclear", "AGN-removed"].map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>
    </Section>
  );
}

/**
 * Main object list page with simple bulk action placeholders and per-object action buttons.
 * To add filters manually later, add filter state here and filter `objects` before rendering rows.
 */
function ObjectBrowser({
  objects,
  searchTerm,
  activeTagFilter,
  sortField,
  sortDirection,
  snoozeRedo,
  canEditStarred,
  onInteraction,
  onTagFilterChange,
  onSortFieldChange,
  onSortDirectionToggle,
  onRedoSnooze,
}: {
  objects: TransientObject[];
  searchTerm: string;
  activeTagFilter: ObjectTagFilter | null;
  sortField: ObjectSortField;
  sortDirection: SortDirection;
  snoozeRedo: SnoozeRedoState | null;
  canEditStarred: boolean;
  onInteraction: InteractionHandler;
  onTagFilterChange: (tagFilter: ObjectTagFilter) => void;
  onSortFieldChange: (sortField: ObjectSortField) => void;
  onSortDirectionToggle: () => void;
  onRedoSnooze: () => void;
}) {
  const redoIndex = snoozeRedo ? Math.min(snoozeRedo.index, objects.length) : -1;

  /**
   * Downloads the currently visible Object List rows as JSON.
   * To change the export format manually, replace the `JSON.stringify` call with CSV/PDF generation.
   */
  const exportVisibleObjects = () => {
    const exportPayload = objects.map((object) => ({
      name: object.name,
      lasairId: object.lasairId,
      ra: object.ra,
      dec: object.dec,
      magnitude: object.magnitude,
      band: object.band,
      classification: object.classification,
      tnsClass: object.tnsClass ?? "N/A",
      tnsName: object.tnsName ?? "N/A",
      classProbabilities: object.classProbabilities,
      starred: object.starred,
      promoted: object.promoted,
      snoozed: object.snoozed,
      followUp: object.followUp,
      priority: object.priority,
      lastActionAt: object.lastActionAt,
      revisitAt: object.revisitAt,
      telescopeCodes: object.telescopeCodes ?? [],
      telescopeCode: object.telescopeCode,
      comment: object.comment,
    }));
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `needle-object-list-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Section
      id="object-list"
      eyebrow="Object List"
      title="Filterable, sortable NEEDLE 2.0 candidate table"
      copy=""
    >
      {searchTerm.trim() ? (
        <p className="search-note">
          Global search found {objects.length} matching object{objects.length === 1 ? "" : "s"}, including snoozed
          objects if they match.
        </p>
      ) : activeTagFilter ? (
        <p className="search-note">Showing {activeTagFilter} objects only.</p>
      ) : (
        <p className="search-note">Snoozed objects are hidden from this list. Use search to find and update them.</p>
      )}
      <div className="browser-layout">
        <div className="table-wrap">
          <div className="table-actions">
            <div className="object-tags">
              <button
                type="button"
                className={`object-tag tag-starred${activeTagFilter === "starred" ? " active" : ""}`}
                aria-pressed={activeTagFilter === "starred"}
                disabled={!canEditStarred}
                title={
                  canEditStarred
                    ? "Filter by starred objects"
                    : "Starred lists are only available for private workspace accounts."
                }
                onClick={() => onTagFilterChange("starred")}
              >
                starred
              </button>
              <button
                type="button"
                className={`object-tag tag-promoted${activeTagFilter === "promoted" ? " active" : ""}`}
                aria-pressed={activeTagFilter === "promoted"}
                onClick={() => onTagFilterChange("promoted")}
              >
                promoted
              </button>
              <button
                type="button"
                className={`object-tag tag-follow-up${activeTagFilter === "follow-up" ? " active" : ""}`}
                aria-pressed={activeTagFilter === "follow-up"}
                onClick={() => onTagFilterChange("follow-up")}
              >
                follow-up
              </button>
            </div>
            <label className="sort-control">
              <span>Sort</span>
              <select
                value={sortField}
                onChange={(event) => onSortFieldChange(event.target.value as ObjectSortField)}
                aria-label="Sort object list by"
              >
                <option value="lastClassified">last detected</option>
                <option value="magnitude">latest mag</option>
                <option value="classification">NEEDLE class</option>
              </select>
            </label>
            <button
              type="button"
              className="sort-direction-button"
              aria-label={`Sort ${sortDirection === "asc" ? "low to high" : "high to low"}`}
              onClick={onSortDirectionToggle}
            >
              {sortDirection === "asc" ? "low to high" : "high to low"}
            </button>
            <button type="button" className="export-json-button" onClick={exportVisibleObjects}>
              Export JSON
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th>Object</th>
                <th>RA / Dec</th>
                <th>TNS Class</th>
                <th>Lasair</th>
                <th>Last Detected</th>
                <th>PS Stamp</th>
                <th>Latest Mag</th>
                <th>NEEDLE Class</th>
                <th>Scores</th>
                <th>Comments</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {objects.map((object, index) => (
                <FragmentWithRedo
                  key={object.id}
                  object={object}
                  index={index}
                  redoIndex={redoIndex}
                  snoozeRedo={snoozeRedo}
                  canEditStarred={canEditStarred}
                  onInteraction={onInteraction}
                  onRedoSnooze={onRedoSnooze}
                />
              ))}
              {snoozeRedo && redoIndex === objects.length ? (
                <RedoRow object={snoozeRedo.object} exiting={snoozeRedo.exiting} onRedoSnooze={onRedoSnooze} />
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

/**
 * Renders a normal object row, plus the redo row immediately before the same list position.
 * To place redo after the object manually, move `RedoRow` below `ObjectRow`.
 */
function FragmentWithRedo({
  object,
  index,
  redoIndex,
  snoozeRedo,
  canEditStarred,
  onInteraction,
  onRedoSnooze,
}: {
  object: TransientObject;
  index: number;
  redoIndex: number;
  snoozeRedo: SnoozeRedoState | null;
  canEditStarred: boolean;
  onInteraction: InteractionHandler;
  onRedoSnooze: () => void;
}) {
  return (
    <>
      {snoozeRedo && redoIndex === index ? (
        <RedoRow object={snoozeRedo.object} exiting={snoozeRedo.exiting} onRedoSnooze={onRedoSnooze} />
      ) : null}
      <ObjectRow object={object} canEditStarred={canEditStarred} onInteraction={onInteraction} />
    </>
  );
}

/**
 * Inline redo row shown at the position where a snoozed object was removed.
 * To change the fade timing manually, edit the `.redo-table-row.exiting` animation and the 360 ms timeout.
 */
function RedoRow({
  object,
  exiting,
  onRedoSnooze,
}: {
  object: TransientObject;
  exiting: boolean;
  onRedoSnooze: () => void;
}) {
  return (
    <tr className={exiting ? "redo-table-row exiting" : "redo-table-row"}>
      <td colSpan={11}>
        <div className="redo-toast inline-redo" role="status">
          <span>{object.name} snoozed</span>
          <button type="button" onClick={onRedoSnooze}>
            redo
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * One row in the object table.
 * The folded action menu uses the action list: star, follow-up, promote, snooze.
 */
function ObjectRow({
  object,
  canEditStarred,
  onInteraction,
}: {
  object: TransientObject;
  canEditStarred: boolean;
  onInteraction: InteractionHandler;
}) {
  const actionMenuRef = useRef<HTMLDetailsElement>(null);
  const selectedActionIcons = getSelectedActionIcons(object);
  const classifiedDisplay = formatLastClassified(object.lastClassified);

  /**
   * Runs one row action and immediately folds the action menu.
   * To keep the menu open manually, remove the `actionMenuRef.current.open = false` line.
   */
  const chooseAction = (update: ObjectInteractionUpdate) => {
    onInteraction(object, update);
    if (actionMenuRef.current) {
      actionMenuRef.current.open = false;
    }
  };

  return (
    <tr>
      <td>
        <a href={`#object-detail?lasairId=${encodeURIComponent(object.lasairId)}`}>{object.name}</a>
        <small>{object.lasairId}</small>
      </td>
      <td>
        {object.ra}
        <small>{object.dec}</small>
      </td>
      <td>
        {object.tnsClass ?? "N/A"}
        <small>{object.tnsName ?? "N/A"}</small>
      </td>
      <td>
        <a href={`https://lasair-ztf.lsst.ac.uk/objects/${object.lasairId}`}>Open</a>
      </td>
      <td>
        {classifiedDisplay.relative}
        <small>{classifiedDisplay.date}</small>
      </td>
      <td>
        <ImageStamp hue={object.imageHue} label={`${object.name} PS stamp`} small />
      </td>
      <td>{`${object.band} = ${object.magnitude} mag`}</td>
      <td>
        <Badge label={object.classification} tone={classColor[object.classification]} />
      </td>
      <td>
        <ClassProbabilityPlot probabilities={object.classProbabilities} />
      </td>
      <td>{object.comment}</td>
      <td>
        <details className="row-action-menu" ref={actionMenuRef}>
          <summary aria-label={`Choose action for ${object.name}`} title={`Choose action for ${object.name}`}>
            <span className="selected-action-icons">
              {selectedActionIcons.map((iconName) => (
                <ActionIcon key={iconName} name={iconName} />
              ))}
            </span>
          </summary>
          <div>
            <button
              type="button"
              className={object.starred ? "active" : undefined}
              aria-pressed={object.starred}
              aria-label={`${object.starred ? "Unstar" : "Star"} ${object.name}`}
              disabled={!canEditStarred}
              onClick={() => chooseAction({ starred: !object.starred })}
              title={
                canEditStarred
                  ? "Star or unstar (private workspace)"
                  : "Starred is only editable for private workspace accounts."
              }
            >
              <ActionIcon name="star" />
            </button>
            <button
              type="button"
              className={isFollowUpTagActive(object) ? "active" : undefined}
              aria-pressed={isFollowUpTagActive(object)}
              aria-label={`Follow-up: ${object.followUp} → ${FOLLOW_UP_CYCLE[object.followUp]} for ${object.name}`}
              onClick={() => chooseAction({ followUp: FOLLOW_UP_CYCLE[object.followUp] })}
              title="follow-up"
            >
              <ActionIcon name="flag" />
            </button>
            <button
              type="button"
              className={object.promoted ? "active" : undefined}
              aria-pressed={object.promoted}
              aria-label={`${object.promoted ? "Unpromote" : "Promote"} ${object.name}`}
              onClick={() => chooseAction({ promoted: !object.promoted })}
              title="promote"
            >
              <ActionIcon name="promote" />
            </button>
            <button
              type="button"
              className={object.snoozed ? "active" : undefined}
              aria-pressed={object.snoozed}
              aria-label={`${object.snoozed ? "Unsnooze" : "Snooze"} ${object.name}`}
              onClick={() => chooseAction({ snoozed: !object.snoozed })}
              title="snooze"
            >
              <ActionIcon name="clock" />
            </button>
          </div>
        </details>
      </td>
    </tr>
  );
}

/**
 * Chooses all icons shown on the folded row action button.
 * To add a new selected state manually, append another condition to this list.
 */
function getSelectedActionIcons(object: TransientObject): ActionIconName[] {
  const icons: ActionIconName[] = [];

  if (object.starred) {
    icons.push("star");
  }

  if (isFollowUpTagActive(object)) {
    icons.push("flag");
  }

  if (object.promoted) {
    icons.push("promote");
  }

  if (object.snoozed) {
    icons.push("clock");
  }

  return icons.length ? icons : ["menu"];
}

type LightCurveHover = {
  clientX: number;
  clientY: number;
  utcDay: string;
  point: PhotometryPoint;
  classification: DailyClassification | null;
};

function MultiBandLightCurve({
  points,
  classificationByDetection,
}: {
  points: PhotometryPoint[];
  classificationByDetection: Map<string, DailyClassification>;
}) {
  const [hover, setHover] = useState<LightCurveHover | null>(null);

  const updateHover = (event: MouseEvent<SVGGElement>, point: PhotometryPoint) => {
    const utcDay = mjdToUtcCalendarDay(point.mjd);
    const key = detectionClassificationKey(point);
    setHover({
      clientX: event.clientX,
      clientY: event.clientY,
      utcDay,
      point,
      classification: classificationByDetection.get(key) ?? null,
    });
  };

  if (!points.length) {
    return <p className="muted-value">No photometry loaded for this object.</p>;
  }

  const mjds = points.map((p) => p.mjd);
  const mags = points.map((p) => p.mag);
  const minMjd = Math.min(...mjds);
  const maxMjd = Math.max(...mjds);
  const minMag = Math.min(...mags) - 0.2;
  const maxMag = Math.max(...mags) + 0.2;
  const padL = 54;
  const padR = 12;
  const padT = 16;
  const padB = 48;
  const W = 468;
  const H = 252;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const spanMjd = maxMjd - minMjd || 1;
  const spanMag = maxMag - minMag || 1;
  const xScale = (mj: number) => padL + ((mj - minMjd) / spanMjd) * innerW;
  const yScale = (magVal: number) => padT + ((magVal - minMag) / spanMag) * innerH;

  const byBand = new Map<string, PhotometryPoint[]>();
  for (const p of points) {
    const b = (p.band || "?").toLowerCase();
    if (!byBand.has(b)) {
      byBand.set(b, []);
    }
    byBand.get(b)!.push(p);
  }
  for (const arr of byBand.values()) {
    arr.sort((a, b) => a.mjd - b.mjd);
  }

  const gridT = [0, 0.25, 0.5, 0.75, 1];
  const vw = typeof globalThis.window !== "undefined" ? globalThis.window.innerWidth : 1024;
  const vh = typeof globalThis.window !== "undefined" ? globalThis.window.innerHeight : 768;
  const cardW = 288;
  const cardH = 220;
  const hoverPosition =
    hover &&
    (() => {
      const left = Math.min(Math.max(10, hover.clientX + 14), vw - cardW - 10);
      const top = Math.min(Math.max(10, hover.clientY + 14), vh - cardH - 10);
      return { left, top };
    })();

  return (
    <div
      className="lightcurve-chart-wrap"
      onMouseLeave={() => setHover(null)}
    >
      {hover && hoverPosition ? (
        <div
          className="lightcurve-hover-card"
          role="tooltip"
          style={{ left: hoverPosition.left, top: hoverPosition.top }}
        >
          <div className="lightcurve-hover-section">
            <h5 className="lightcurve-hover-title">Detection</h5>
            <p className="lightcurve-hover-meta">
              MJD {hover.point.mjd.toFixed(4)} · UTC day {hover.utcDay}
            </p>
            <p className="lightcurve-hover-meta">
              Band <strong>{hover.point.band}</strong>, mag{" "}
              <strong>{Number.isFinite(hover.point.mag) ? hover.point.mag.toFixed(3) : "—"}</strong>
              {hover.point.magErr != null && Number.isFinite(hover.point.magErr)
                ? ` ± ${hover.point.magErr.toFixed(3)}`
                : null}
            </p>
          </div>
          <div className="lightcurve-hover-section lightcurve-hover-section--needle">
            <h5 className="lightcurve-hover-title">NEEDLE (this detection)</h5>
            {hover.classification ? (
              <>
                <p className="lightcurve-hover-class-row">
                  <Badge
                    label={hover.classification.class}
                    tone={classColor[hover.classification.class as ObjectClass] ?? "slate"}
                  />
                  <span className="lightcurve-hover-conf">
                    {Math.round(hover.classification.confidence * 100)}% conf.
                  </span>
                </p>
                <p className="lightcurve-hover-meta">
                  {hover.classification.modelVersion}
                  <time dateTime={hover.classification.classifiedAt}>
                    {" "}
                    · {formatCommentTime(hover.classification.classifiedAt)}
                  </time>
                </p>
                <ul className="lightcurve-hover-probs">
                  {Object.entries(hover.classification.rawProbs)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <li key={k}>
                        {k}: {(v * 100).toFixed(1)}%
                      </li>
                    ))}
                </ul>
              </>
            ) : (
              <p className="lightcurve-hover-none">No classification computed for this point.</p>
            )}
          </div>
        </div>
      ) : null}
      <svg className="lightcurve-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Multi-band light curve">
        <title>Light curve from photometry JSON</title>
        {gridT.map((t) => {
          const mj = minMjd + t * spanMjd;
          const x = xScale(mj);
          return (
            <g key={`gx-${t}`}>
              <line
                x1={x}
                y1={padT}
                x2={x}
                y2={H - padB}
                stroke="rgba(148,163,184,0.14)"
                strokeWidth={1}
              />
              <text x={x} y={H - padB + 16} textAnchor="middle" fill="#94a3b8" fontSize={9}>
                {mj.toFixed(2)}
              </text>
            </g>
          );
        })}
        {gridT.map((t) => {
          const magVal = minMag + t * spanMag;
          const y = yScale(magVal);
          return (
            <g key={`gy-${t}`}>
              <line
                x1={padL}
                y1={y}
                x2={W - padR}
                y2={y}
                stroke="rgba(148,163,184,0.14)"
                strokeWidth={1}
              />
              <text x={padL - 8} y={y + 4} textAnchor="end" fill="#94a3b8" fontSize={9}>
                {magVal.toFixed(2)}
              </text>
            </g>
          );
        })}
        <text
          x={padL + innerW / 2}
          y={H - 4}
          textAnchor="middle"
          fill="#94a3b8"
          fontSize={10}
          fontWeight={600}
          className="chart-axis-title"
        >
          Modified Julian Date (MJD)
        </text>
        <text
          transform={`translate(13, ${padT + innerH / 2}) rotate(-90)`}
          textAnchor="middle"
          fill="#94a3b8"
          fontSize={10}
          fontWeight={600}
          className="chart-axis-title"
        >
          Magnitude (mag)
        </text>
        {[...byBand.entries()].map(([band, pts]) => {
          const color = LC_BAND_COLORS[band] ?? LC_BAND_COLORS.default;
          const d = pts
            .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.mjd)} ${yScale(p.mag)}`)
            .join(" ");
          return <path key={`line-${band}`} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />;
        })}
        {[...byBand.entries()].flatMap(([band, pts]) =>
          pts.map((p, i) => (
            <g
              key={`${band}-${i}-${p.mjd}`}
              onMouseEnter={(e) => updateHover(e, p)}
              onMouseMove={(e) => updateHover(e, p)}
            >
              <circle
                cx={xScale(p.mjd)}
                cy={yScale(p.mag)}
                r={12}
                fill="transparent"
                className="lightcurve-hit"
              />
              <circle
                cx={xScale(p.mjd)}
                cy={yScale(p.mag)}
                r={3.5}
                fill={LC_BAND_COLORS[band] ?? LC_BAND_COLORS.default}
                stroke="rgba(15,23,42,0.85)"
                strokeWidth={1}
                className="lightcurve-point"
              />
            </g>
          )),
        )}
      </svg>
      <ul className="lightcurve-legend">
        {[...byBand.keys()].map((b) => (
          <li key={b}>
            <span className="legend-swatch" style={{ background: LC_BAND_COLORS[b] ?? LC_BAND_COLORS.default }} />
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TelescopeFacilityEditor({
  object,
  telescopes,
  dataSource,
  onInteraction,
  onTelescopeAdded,
  hint = "Pick a facility from the dropdown to add it to the list (no duplicates). Save commits; Clear removes all. Use “Add new telescope…” to register a code.",
  variant = "popover",
}: {
  object: TransientObject;
  telescopes: ObservingTelescope[];
  dataSource: "database" | "fallback";
  onInteraction: InteractionHandler;
  onTelescopeAdded: (telescope: ObservingTelescope) => void;
  hint?: string;
  variant?: "popover" | "inline";
}) {
  const [telescopeCodesDraft, setTelescopeCodesDraft] = useState<string[]>(() => [...(object.telescopeCodes ?? [])]);
  const [pickTelescope, setPickTelescope] = useState("");
  const [newTelCode, setNewTelCode] = useState("");
  const [newTelName, setNewTelName] = useState("");

  useEffect(() => {
    setTelescopeCodesDraft([...(object.telescopeCodes ?? [])]);
    setPickTelescope("");
    setNewTelCode("");
    setNewTelName("");
  }, [object.lasairId, object.lastActionAt, (object.telescopeCodes ?? []).join("\u0001"), object.telescopeCode]);

  const commitNewTelescopeDraft = async () => {
    if (pickTelescope !== KANBAN_ADD_TELESCOPE_SELECT_VALUE) {
      return;
    }
    const raw = newTelCode.trim();
    if (!raw) {
      return;
    }
    const code = raw.toUpperCase().replace(/\s+/g, "_");
    if (telescopeCodesDraft.includes(code)) {
      setPickTelescope("");
      setNewTelCode("");
      setNewTelName("");
      return;
    }
    const existing = telescopes.find((t) => t.code === code);
    if (existing) {
      setTelescopeCodesDraft((d) => [...d, code]);
    } else if (dataSource === "fallback") {
      onTelescopeAdded({ code, displayName: newTelName.trim() || code });
      setTelescopeCodesDraft((d) => [...d, code]);
    } else {
      try {
        const created = await postObservingTelescope(raw, newTelName.trim() || undefined);
        onTelescopeAdded(created);
        setTelescopeCodesDraft((d) => [...d, created.code]);
      } catch (error) {
        console.error(error);
        return;
      }
    }
    setPickTelescope("");
    setNewTelCode("");
    setNewTelName("");
  };

  const saveTelescopeList = (closeTrigger?: HTMLElement | null) => {
    onInteraction(object, { telescopeCodes: [...telescopeCodesDraft] });
    if (closeTrigger) {
      closeKanbanDetails(closeTrigger);
    }
  };

  const clearTelescopeList = (closeTrigger?: HTMLElement | null) => {
    setTelescopeCodesDraft([]);
    setPickTelescope("");
    setNewTelCode("");
    setNewTelName("");
    onInteraction(object, { telescopeCodes: [] });
    if (closeTrigger) {
      closeKanbanDetails(closeTrigger);
    }
  };

  const inner = (
    <>
      <p
        className={`kanban-popover-hint kanban-telescope-hint${
          variant === "inline" ? " detail-telescope-hint" : ""
        }`}
      >
        {hint}
      </p>
      <ul className="kanban-telescope-chips" aria-label="Telescopes assigned to this object">
        {telescopeCodesDraft.map((code) => (
          <li key={code} className="kanban-telescope-chip">
            <span>{kanbanTelescopeLabel(code, telescopes)}</span>
            <button
              type="button"
              className="kanban-telescope-chip-remove"
              aria-label={`Remove ${code}`}
              onClick={() => setTelescopeCodesDraft((d) => d.filter((c) => c !== code))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <label className="kanban-popover-label">
        Add from list or register new
        <select
          value={pickTelescope}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "") {
              setPickTelescope("");
              return;
            }
            if (value === KANBAN_ADD_TELESCOPE_SELECT_VALUE) {
              setPickTelescope(value);
              setNewTelCode("");
              setNewTelName("");
              return;
            }
            setTelescopeCodesDraft((d) => (d.includes(value) ? d : [...d, value]));
            setPickTelescope("");
          }}
        >
          <option value="">Choose facility…</option>
          {telescopes
            .filter((t) => !telescopeCodesDraft.includes(t.code))
            .map((telescope) => (
              <option key={telescope.code} value={telescope.code}>
                {telescope.displayName} ({telescope.code})
              </option>
            ))}
          <option value={KANBAN_ADD_TELESCOPE_SELECT_VALUE}>Add new telescope…</option>
        </select>
      </label>
      {pickTelescope === KANBAN_ADD_TELESCOPE_SELECT_VALUE ? (
        <div className="kanban-new-telescope">
          <input
            placeholder="Code e.g. ESO_4M"
            value={newTelCode}
            onChange={(event) => setNewTelCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitNewTelescopeDraft();
              }
            }}
          />
          <input
            placeholder="Display name (optional)"
            value={newTelName}
            onChange={(event) => setNewTelName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitNewTelescopeDraft();
              }
            }}
          />
          <button
            type="button"
            className="secondary kanban-telescope-register-btn"
            disabled={!newTelCode.trim()}
            onClick={() => void commitNewTelescopeDraft()}
          >
            Register &amp; add
          </button>
        </div>
      ) : null}
      <div className="kanban-popover-actions">
        {variant === "inline" ? (
          <>
            <button type="button" onClick={() => saveTelescopeList()}>
              Save telescopes
            </button>
            <button type="button" className="secondary" onClick={() => clearTelescopeList()}>
              Clear all
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={(event) => saveTelescopeList(event.currentTarget)}>
              Save
            </button>
            <button type="button" className="secondary" onClick={(event) => clearTelescopeList(event.currentTarget)}>
              Clear
            </button>
          </>
        )}
      </div>
    </>
  );

  if (variant === "inline") {
    return <div className="detail-telescope-editor">{inner}</div>;
  }
  return inner;
}

/**
 * Detailed single-object analysis page.
 * To add tabs or more scientific panels manually, add new `Panel` blocks inside the `detail-grid`.
 */
function ObjectDetail({
  object,
  onInteraction,
  onPostComment,
  telescopes,
  dataSource,
  onTelescopeAdded,
  canEditStarred,
}: {
  object: TransientObject;
  onInteraction: InteractionHandler;
  onPostComment: CommentPostHandler;
  telescopes: ObservingTelescope[];
  dataSource: "database" | "fallback";
  onTelescopeAdded: (telescope: ObservingTelescope) => void;
  canEditStarred: boolean;
}) {
  const [draftComment, setDraftComment] = useState("");
  const [localComments, setLocalComments] = useState(object.comments);
  const [detailPhotometry, setDetailPhotometry] = useState<PhotometryPoint[]>([]);
  const [detailHistory, setDetailHistory] = useState<DailyClassification[]>([]);
  const [detailLoadState, setDetailLoadState] = useState<"idle" | "loading" | "ready">("idle");

  useEffect(() => {
    setLocalComments(object.comments);
  }, [object.comments, object.lasairId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (dataSource === "database") {
        setDetailLoadState("loading");
        const payload = await fetchObjectDetail(object.lasairId);
        if (cancelled) {
          return;
        }
        setDetailPhotometry(payload.photometry);
        setDetailHistory(payload.classificationHistory);
        setDetailLoadState("ready");
      } else {
        setDetailPhotometry([]);
        setDetailHistory([]);
        setDetailLoadState("idle");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [object.lasairId, dataSource]);

  const photometry = useMemo(() => {
    let pts = detailPhotometry;
    if ((!pts || pts.length === 0) && dataSource === "fallback") {
      pts = syntheticPhotometry(object);
    }
    return pts;
  }, [detailPhotometry, dataSource, object]);

  const classificationByDetection = useMemo(
    () => buildClassificationByDetection(photometry, object, dataSource, detailHistory),
    [photometry, object, dataSource, detailHistory],
  );

  const sortedProbs = useMemo(
    () => Object.entries(object.classProbabilities).sort((a, b) => b[1] - a[1]),
    [object.classProbabilities],
  );

  // const legacyImage = object.psImageUrls?.[0] ?? null;
  const aladinUrl = buildAladinLiteUrl(object);
  const { ra, dec } = objectRaDecDegrees(object);

  /**
   * Adds a comment to the Object Detail page and persists it through the parent handler.
   * To change the publisher manually, update the backend user used by `postObjectComment`.
   */
  const postComment = async () => {
    const trimmedComment = draftComment.trim();

    if (!trimmedComment) {
      return;
    }

    try {
      await onPostComment(object, trimmedComment);
      setDraftComment("");
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <Section
      id="object-detail"
      eyebrow="Object Detail"
      title={`${object.name}`}
      // copy="Coordinates, Aladin reference, NEEDLE probabilities, photometry-driven light curves with per-detection class estimates, tags, follow-up facilities, and comments."
    copy=""
    >
      <div className="detail-grid">
        <div className="detail-tag-row">
          <span className="detail-tag-label">Tags</span>
          <div className="object-tags object-tags--detail">
            <button
              type="button"
              className={`object-tag tag-starred${object.starred ? " active" : ""}`}
              disabled={!canEditStarred}
              aria-pressed={object.starred}
              onClick={() => onInteraction(object, { starred: !object.starred })}
            >
              starred
            </button>
            <button
              type="button"
              className={`object-tag tag-promoted${object.promoted ? " active" : ""}`}
              aria-pressed={object.promoted}
              onClick={() => onInteraction(object, { promoted: !object.promoted })}
            >
              promoted
            </button>
            <button
              type="button"
              className={`object-tag tag-follow-up${isFollowUpTagActive(object) ? " active" : ""}`}
              aria-pressed={isFollowUpTagActive(object)}
              onClick={() =>
                onInteraction(object, { followUp: isFollowUpTagActive(object) ? "Snooze" : "To Do" })
              }
            >
              follow-up
            </button>
          </div>
        </div>

        <Panel title="Overview" eyebrow="Sky position & Template image">
          <div className="detail-overview-skies">
            <div className="detail-aladin-wrap">
              <span className="detail-embed-label">Aladin Lite</span>
              <iframe
                title="Aladin sky atlas reference image"
                className="detail-aladin-frame"
                src={aladinUrl}
                loading="lazy"
                allowFullScreen
                allow="fullscreen"
              />
            </div>
          </div>
          <dl className="detail-coords-grid">
            <div>
              <dt>RA (°)</dt>
              <dd>{Number.isFinite(ra) ? ra.toFixed(6) : object.ra}</dd>
            </div>
            <div>
              <dt>Dec (°)</dt>
              <dd>{Number.isFinite(dec) ? (dec >= 0 ? `+${dec.toFixed(6)}` : dec.toFixed(6)) : object.dec}</dd>
            </div>
            <div>
              <dt>TNS class</dt>
              <dd>{object.tnsClass ?? "—"}</dd>
            </div>
            <div>
              <dt>TNS name</dt>
              <dd>{object.tnsName ?? "—"}</dd>
            </div>
            <div>
              <dt>NEEDLE class</dt>
              <dd>
                <Badge label={object.classification} tone={classColor[object.classification]} />
              </dd>
            </div>
            <div>
              <dt>Top confidence</dt>
              <dd>{Math.round(object.confidence * 100)}%</dd>
            </div>
          </dl>
          {/* <div className="summary-card summary-card--compact">
            <Progress value={object.confidence} />
            <p>
              AGN removed: <strong>{object.agnRemoved ? "Yes" : "No"}</strong>
            </p>
            <p>Quality flags: {object.qualityFlags.length ? object.qualityFlags.join(", ") : "—"}</p>
          </div> */}
        </Panel>

        <Panel title="Light curve" eyebrow="Photometry & per-detection NEEDLE predictions">
          <p className="detail-cadence-note">
            Class probabilities for each available detection are estimated from NEEDLE 2.0 model output from the discovery day to current detection day with step size of 1 day at minima. Hover any point for detection metadata and the full probability vector.
          </p>
          {dataSource === "database" && detailLoadState === "loading" ? (
            <p className="muted-value">Loading photometry…</p>
          ) : null}
          <MultiBandLightCurve points={photometry} classificationByDetection={classificationByDetection} />
          <div className="detail-prob-block detail-prob-block--below-curve">
            <h4 className="detail-subheading">Latest class probabilities:</h4>
            <div className="detail-prob-table-wrap">
              <table className="detail-prob-table">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Probability</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProbs.length ? (
                    sortedProbs.map(([cls, p]) => (
                      <tr key={cls}>
                        <td>{cls}</td>
                        <td>{(p * 100).toFixed(1)}%</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={2} className="muted-value">
                        No probability vector on this row.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>

        <Panel title="Follow-up queue" eyebrow="Follow-up & Priority settings">
          <label className="detail-field">
            <span>Follow-up status</span>
            <select
              value={object.followUp}
              onChange={(event) => onInteraction(object, { followUp: event.target.value as FollowUpStatus })}
            >
              {(["To Do", "Observing", "Completed", "Snooze"] as const).map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="detail-field">
            <span>Priority</span>
            <select
              value={object.priority}
              onChange={(event) =>
                onInteraction(object, { priority: event.target.value as TransientObject["priority"] })
              }
            >
              {(["High", "Medium", "Low", "Monitor"] as const).map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </select>
          </label>
          <div className="detail-telescope-visibility-merge">
            <span className="detail-embed-label">Observing facilities &amp; night visibility</span>
            <TelescopeFacilityEditor
              object={object}
              telescopes={telescopes}
              dataSource={dataSource}
              onInteraction={onInteraction}
              onTelescopeAdded={onTelescopeAdded}
              hint="Choose a facility from the dropdown to add it (duplicates ignored). Save persists telescope_codes on this object and updates the altitude plot below."
              variant="inline"
            />
            <div className="detail-visibility-wrap detail-visibility-wrap--merged">
              <div className="detail-visibility-body">
                <TelescopeVisibilityPanel
                  key={object.lasairId}
                  raDeg={ra}
                  decDeg={dec}
                  telescopes={telescopes}
                  telescopeCodes={[...(object.telescopeCodes ?? []), object.telescopeCode ?? ""].filter(Boolean)}
                />
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="Comments" eyebrow="Object discussion">
          <div className="object-comments">
            {localComments.length ? (
              localComments.map((comment) => (
                <article className="object-comment" key={comment.id}>
                  <div>
                    <strong>{comment.publisher}</strong>
                    <time>{formatCommentTime(comment.createdAt)}</time>
                  </div>
                  <p>{comment.body}</p>
                </article>
              ))
            ) : (
              <p className="muted-value">No comments yet.</p>
            )}
            <textarea
              aria-label="Write object comment"
              placeholder="Write a comment for this object..."
              value={draftComment}
              onChange={(event) => setDraftComment(event.target.value)}
            />
            <button type="button" onClick={postComment}>
              Post
            </button>
          </div>
        </Panel>
      </div>
      <button type="button" className="floating-action">
        Re-classify with NEEDLE 2.0
      </button>
    </Section>
  );
}

/**
 * One draggable follow-up card with priority, revisit reminder, and telescope controls.
 */
function KanbanFollowUpCard({
  object,
  telescopes,
  dataSource,
  onInteraction,
  onTelescopeAdded,
}: {
  object: TransientObject;
  telescopes: ObservingTelescope[];
  dataSource: "database" | "fallback";
  onInteraction: InteractionHandler;
  onTelescopeAdded: (telescope: ObservingTelescope) => void;
}) {
  const priorities = ["High", "Medium", "Low", "Monitor"] as const;
  const [revisitDate, setRevisitDate] = useState("");
  const [revisitTime, setRevisitTime] = useState("");

  const telescopeSubmetaLine = (() => {
    const fromList = object.telescopeCodes ?? [];
    const codes = fromList.length > 0 ? fromList : object.telescopeCode ? [object.telescopeCode] : [];
    if (!codes.length) {
      return null;
    }
    return codes.map((code) => kanbanTelescopeLabel(code, telescopes)).join(" · ");
  })();

  const revisitSummary = useMemo(() => {
    if (!object.revisitAt) {
      return null;
    }
    return formatRevisitHint(object.revisitAt) || object.revisitAt;
  }, [object.revisitAt]);

  useEffect(() => {
    if (object.revisitAt) {
      const next = splitRevisitLocal(object.revisitAt);
      setRevisitDate(next.date);
      setRevisitTime(next.time);
    } else {
      setRevisitDate("");
      setRevisitTime("");
    }
  }, [object.lasairId, object.revisitAt]);

  const applyRevisit = (): boolean => {
    if (!revisitDate) {
      return false;
    }
    const timePart = revisitTime.trim() || "10:00";
    const parsed = new Date(`${revisitDate}T${timePart}`);
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    onInteraction(object, { revisitAt: parsed.toISOString() });
    return true;
  };

  const onKanbanToolToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) {
      closeSiblingKanbanToolMenus(event.currentTarget);
    }
  };

  const onRevisitToolToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    onKanbanToolToggle(event);
    if (!event.currentTarget.open) {
      return;
    }
    if (object.revisitAt) {
      const next = splitRevisitLocal(object.revisitAt);
      setRevisitDate(next.date);
      setRevisitTime(next.time);
    } else {
      const next = defaultRevisitPlusSevenLocal();
      setRevisitDate(next.date);
      setRevisitTime(next.time);
    }
  };

  const latestComment = latestCommentForCard(object);

  return (
    <>
      <div className="kanban-card-head">
        <Badge label={object.classification} tone={classColor[object.classification]} />
        <div className="kanban-card-tools" onMouseDown={(event) => event.stopPropagation()}>
          <details className="kanban-tool kanban-priority-fold" data-kanban-tool="priority" onToggle={onKanbanToolToggle}>
            <summary className="kanban-priority-trigger" title="Priority" aria-label={`Priority: ${object.priority}`}>
              <span className="kanban-priority-label">Pri</span>
              <span className="kanban-priority-current">{object.priority}</span>
              <span className="kanban-priority-chevron" aria-hidden>
                ▼
              </span>
            </summary>
            <div className="kanban-priority-slide">
              <div className="kanban-priority-slide-inner">
                <ul className="kanban-priority-list">
                  {priorities.map((priority) => (
                    <li key={priority}>
                      <button
                        type="button"
                        className={`kanban-priority-option${object.priority === priority ? " active" : ""}`}
                        onClick={(event) => {
                          onInteraction(object, { priority });
                          closeKanbanDetails(event.currentTarget);
                        }}
                      >
                        {priority}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
          <details className="kanban-tool" data-kanban-tool="revisit" onToggle={onRevisitToolToggle}>
            <summary className="kanban-icon-button" aria-label="Revisit reminder" title="Revisit reminder">
              <ActionIcon name="clock" />
            </summary>
            <div className="kanban-popover">
              <p className="kanban-popover-hint">
                With no reminder set, opening this panel defaults to one week from today at 10:00. Change the date and time to match your plan.
              </p>
              <label className="kanban-popover-label">
                Revisit date
                <input type="date" value={revisitDate} onChange={(event) => setRevisitDate(event.target.value)} />
              </label>
              <label className="kanban-popover-label">
                Time
                <input type="time" value={revisitTime} onChange={(event) => setRevisitTime(event.target.value)} step={60} />
              </label>
              <div className="kanban-popover-actions">
                <button
                  type="button"
                  onClick={(event) => {
                    if (applyRevisit()) {
                      closeKanbanDetails(event.currentTarget);
                    }
                  }}
                  disabled={!revisitDate}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={(event) => {
                    setRevisitDate("");
                    setRevisitTime("");
                    onInteraction(object, { revisitAt: null });
                    closeKanbanDetails(event.currentTarget);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          </details>
          <details className="kanban-tool" data-kanban-tool="telescope" onToggle={onKanbanToolToggle}>
            <summary className="kanban-icon-button" aria-label="Observing telescope" title="Observing telescope">
              <ActionIcon name="telescope" />
            </summary>
            <div className="kanban-popover kanban-popover--wide">
              <TelescopeFacilityEditor
                object={object}
                telescopes={telescopes}
                dataSource={dataSource}
                onInteraction={onInteraction}
                onTelescopeAdded={onTelescopeAdded}
                hint="Pick a facility from the dropdown to add it; Save commits the same telescope_codes as object detail. Use “Add new telescope…” + Register & add for new codes."
              />
            </div>
          </details>
        </div>
      </div>
      <strong>
        <a
          href={`#object-detail?lasairId=${encodeURIComponent(object.lasairId)}`}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {object.name}
        </a>
      </strong>
      <small className="task-card-id">{object.lasairId}</small>
      {latestComment ? (
        <div className="kanban-card-comment" title={latestComment.body}>
          <span className="kanban-card-comment-label">Latest comment</span>
          {latestComment.publisher || latestComment.createdAt ? (
            <div className="kanban-card-comment-meta">
              {latestComment.publisher ? (
                <span className="kanban-card-comment-author">{latestComment.publisher}</span>
              ) : null}
              {latestComment.createdAt ? (
                <time className="kanban-card-comment-time" dateTime={latestComment.createdAt}>
                  {formatCommentTime(latestComment.createdAt)}
                </time>
              ) : null}
            </div>
          ) : null}
          <p className="kanban-card-comment-body">{latestComment.body}</p>
        </div>
      ) : null}
      {revisitSummary || telescopeSubmetaLine ? (
        <div className="kanban-card-submeta">
          {revisitSummary ? (
            <div className="kanban-submeta-row kanban-submeta-row--revisit" data-kanban-readout="revisit">
              <span className="kanban-submeta-label">Revisit</span>
              <span className="kanban-submeta-value">{revisitSummary}</span>
            </div>
          ) : null}
          {telescopeSubmetaLine ? (
            <div className="kanban-submeta-row kanban-submeta-row--telescope" data-kanban-readout="telescope">
              <span className="kanban-submeta-label">Telescopes</span>
              <span className="kanban-submeta-value">{telescopeSubmetaLine}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Kanban-style follow-up queue: three lanes (To Do, Observing, Completed). Snooze status is only from the object list.
 * Drops call the same API as the object list.
 */
function FollowUpQueue({
  objects,
  telescopes,
  dataSource,
  onInteraction,
  onTelescopeAdded,
}: {
  objects: TransientObject[];
  telescopes: ObservingTelescope[];
  dataSource: "database" | "fallback";
  onInteraction: InteractionHandler;
  onTelescopeAdded: (telescope: ObservingTelescope) => void;
}) {
  const lanes = ["To Do", "Observing", "Completed"] as const;
  const laneOrderRef = useRef<Partial<Record<FollowUpStatus, string[]>>>({});
  const [dragOverLane, setDragOverLane] = useState<FollowUpStatus | null>(null);
  const dragPreviewRef = useRef<HTMLElement | null>(null);

  const discardDragPreview = () => {
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
  };

  useEffect(() => {
    const dismissKanbanToolsOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      document.querySelectorAll<HTMLDetailsElement>(".kanban .kanban-tool[open]").forEach((menu) => {
        if (!shouldKeepKanbanToolOpen(menu, target)) {
          menu.open = false;
        }
      });
    };

    const dismissKanbanToolsOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      document.querySelectorAll<HTMLDetailsElement>(".kanban .kanban-tool[open]").forEach((menu) => {
        menu.open = false;
      });
    };

    document.addEventListener("pointerdown", dismissKanbanToolsOnPointerDown, true);
    document.addEventListener("keydown", dismissKanbanToolsOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissKanbanToolsOnPointerDown, true);
      document.removeEventListener("keydown", dismissKanbanToolsOnEscape);
      dragPreviewRef.current?.remove();
      dragPreviewRef.current = null;
    };
  }, []);

  const boardObjects = useMemo(() => objects.filter((object) => isOnFollowUpBoard(object)), [objects]);

  const handleDragStart = (event: DragEvent<HTMLDivElement>, lasairId: string) => {
    discardDragPreview();
    const element = event.currentTarget;
    dragPreviewRef.current = mountKanbanDragPreview(element, event);
    event.dataTransfer.setData("text/lasair-id", lasairId);
    event.dataTransfer.effectAllowed = "move";
  };

  const handleDragEndCard = () => {
    discardDragPreview();
    setDragOverLane(null);
  };

  const handleDrop = (event: DragEvent<HTMLElement>, lane: FollowUpStatus) => {
    event.preventDefault();
    setDragOverLane(null);
    const lasairId = event.dataTransfer.getData("text/lasair-id");
    const moved = boardObjects.find((object) => object.lasairId === lasairId);
    if (!moved || moved.followUp === lane) {
      return;
    }
    onInteraction(moved, { followUp: lane });
  };

  return (
    <Section
      id="follow-up-queue"
      eyebrow="Follow-up Queue"
      title="NEEDLE candidates' observing workflow"
      copy="Set priority (High / Medium / Low / Monitor), a revisit date and time (defaults to one week ahead at 10:00 when you open the reminder with none set), and an observing telescope on each card. New telescopes are saved to PostgreSQL. Drag cards between lanes to update workflow status. Card order within a lane follows priority only after you load or refresh this page; changing priority updates the label without reshuffling."
    >
      <div className="kanban">
        {lanes.map((lane) => ( 
          <article
            className={`lane${dragOverLane === lane ? " lane--drop-target" : ""}`}
            key={lane}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDragEnter={() => setDragOverLane(lane)}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragOverLane(null);
              }
            }}
            onDrop={(event) => handleDrop(event, lane)}
          >
            <h3>{followUpQueueLaneLabel(lane)}</h3>
            {orderKanbanLaneStable(
              lane,
              boardObjects.filter((object) => object.followUp === lane),
              laneOrderRef,
            ).map((object) => (
                <div
                  className="task-card task-card--draggable"
                  key={object.lasairId}
                  draggable
                  onDragStart={(event) => handleDragStart(event, object.lasairId)}
                  onDragEnd={handleDragEndCard}
                  role="listitem"
                >
                  <KanbanFollowUpCard
                    object={object}
                    telescopes={telescopes}
                    dataSource={dataSource}
                    onInteraction={onInteraction}
                    onTelescopeAdded={onTelescopeAdded}
                  />
                </div>
              ))}
          </article>
        ))}
      </div>
    </Section>
  );
}

/**
 * Static model transparency and quality-control page.
 * To connect real model telemetry manually, replace the hard-coded values with API-provided model metrics.
 */
function ModelMonitor() {
  return (
    <Section
      id="model-monitor"
      eyebrow="Model Monitor"
      title="NEEDLE 2.0 transparency and operations"
      copy="Track AGN removal, quality-control flags, training recency, and per-object feature importance."
    >
      <div className="model-grid">
        <Panel title="Feature Importance" eyebrow="Explain NEEDLE 2.0">
          {["Color evolution", "Host offset", "Rise time", "Historical variability"].map((feature, index) => (
            <div className="feature-row" key={feature}>
              <span>{feature}</span>
              <Progress value={[0.91, 0.78, 0.62, 0.18][index]} />
            </div>
          ))}
        </Panel>
        <Panel title="Quality Control" eyebrow="Current run">
          <Status label="Processed alerts" value="18,542" />
          <Status label="Rejected stamps" value="412" />
          <Status label="Webhook uptime" value="99.98%" />
          <Status label="Retraining cadence" value="Weekly" />
        </Panel>
      </div>
    </Section>
  );
}

/**
 * Admin and account page containing authentication options, RBAC, audit log, and schema overview.
 * To add real account management manually, wire these buttons to auth endpoints.
 */
function AdminPanel({ auditEvents }: { auditEvents: string[] }) {
  return (
    <Section
      id="admin"
      eyebrow="Admin & Account"
      title="Login, account, security, and platform operations"
      copy="Top-right account controls gather sign in, profile settings, role-based access control, audit logging, usage analytics, and model retraining controls."
    >
      <div className="admin-grid">
        <Panel title="Account Access" eyebrow="Authentication">
          {["Institutional SSO", "ORCID login", "Google login", "Email/password + 2FA"].map((method) => (
            <label key={method}>
              <input type="checkbox" defaultChecked /> {method}
            </label>
          ))}
          <button type="button">Sign in</button>
          <button type="button" className="secondary">
            Create account
          </button>
        </Panel>
        <Panel title="Access Controls" eyebrow="RBAC">
          {["admin", "team_lead", "member", "viewer"].map((role) => (
            <label key={role}>
              <input type="checkbox" defaultChecked={role !== "viewer"} /> {role}
            </label>
          ))}
        </Panel>
        <Panel title="Audit Log" eyebrow="Compliance">
          <ul className="audit-list">
            {auditEvents.map((event) => (
              <li key={event}>{event}</li>
            ))}
          </ul>
        </Panel>
        <Panel title="Backend Blueprint" eyebrow="System architecture">
          <Architecture />
        </Panel>
      </div>
    </Section>
  );
}

/**
 * Shows the database tables used by the prototype.
 * To keep this in sync manually, update the `tables` array when schema tables are added or renamed.
 */
function Architecture() {
  const tables = [
    "users",
    "objects",
    "needle_classifications",
    "user_object_interactions",
    "follow_up",
    "audit_log",
  ];

  return (
    <div className="architecture-grid">
      {tables.map((table) => (
        <article key={table}>
          <strong>{table}</strong>
          <span>PostgreSQL table</span>
        </article>
      ))}
    </div>
  );
}

/**
 * Reusable page section wrapper with eyebrow, title, copy, and content.
 * To change section spacing or heading structure manually, edit this component and related CSS once.
 */
function Section({
  id,
  eyebrow,
  title,
  copy,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  copy: string;
  children: ReactNode;
}) {
  return (
    <section className="content-section" id={id}>
      <div className="section-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Reusable card component for dashboard/detail/admin panels.
 * To change all cards manually, edit this markup or the `.panel` styles.
 */
function Panel({ title, eyebrow, children }: { title: string; eyebrow: string; children: ReactNode }) {
  return (
    <article className="panel">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {children}
    </article>
  );
}

/**
 * Classification badge component.
 * To add a new class color manually, extend `classColor` and add a matching `.badge-*` CSS rule.
 */
function Badge({ label, tone }: { label: string; tone: string }) {
  return (
    <span className={`badge badge-${tone}`} aria-label={`Classification ${label}`}>
      {label}
    </span>
  );
}

/**
 * Icon used by the folded object action button.
 * To change the visual logo manually, replace the SVG path for the matching `name`.
 */
function ActionIcon({ name }: { name: ActionIconName }) {
  const paths: Record<ActionIconName, string> = {
    star: "M12 3.2l2.6 5.2 5.8.8-4.2 4.1 1 5.7-5.2-2.7L6.8 19l1-5.7-4.2-4.1 5.8-.8L12 3.2z",
    clock: "M12 4a8 8 0 108 8 8 8 0 00-8-8zm.7 4.2v4.1l3 1.8-.8 1.3-3.8-2.3V8.2z",
    flag: "M6 4.5h9.8l-.9 3 1.1 3H7.6V20H6z",
    promote: "M12 3l7 7h-4v6H9v-6H5zm-5 15h10v2H7z",
    menu: "M5 7h14v2H5zm0 4h14v2H5zm0 4h14v2H5z",
    telescope:
      "M4 18h16M7 18l2.2-9h5.6L17 18M9.5 7h5L14 5h-4L9.5 7zM10 11h4",
  };

  return (
    <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

/**
 * Confidence progress bar.
 * To change display precision manually, adjust the `Math.round(value * 100)` formatting.
 */
function Progress({ value }: { value: number }) {
  return (
    <span className="progress" aria-label={`${Math.round(value * 100)} percent confidence`}>
      <span style={{ width: `${value * 100}%` }} />
      <strong>{Math.round(value * 100)}%</strong>
    </span>
  );
}

/**
 * Compact class-probability display for one object.
 * The highest-scoring class is highlighted; to change the visual style manually, edit `.class-probability-*` CSS.
 */
function ClassProbabilityPlot({ probabilities }: { probabilities: Record<string, number> }) {
  const entries = Object.entries(probabilities).sort(([, firstScore], [, secondScore]) => secondScore - firstScore);
  const topScore = entries[0]?.[1] ?? 0;
  const classDictionary = `{ ${entries.map(([className, score]) => `"${className}": ${score.toFixed(2)}`).join(", ")} }`;

  if (!entries.length) {
    return <span className="muted-value">N/A</span>;
  }

  return (
    <div className="class-probability-plot" aria-label="Class probability scores" tabIndex={0}>
      {entries.slice(0, 4).map(([className, score]) => {
        const isTopClass = score === topScore;

        return (
          <div className={isTopClass ? "class-probability-row top" : "class-probability-row"} key={className}>
            <span className="class-probability-label">{className}</span>
            <span className="class-probability-track">
              <span style={{ width: `${Math.max(score * 100, 4)}%` }} />
            </span>
          </div>
        );
      })}
      <span className="class-probability-tooltip">{classDictionary}</span>
    </div>
  );
}

/**
 * Mock Pan-STARRS image stamp placeholder.
 * To use real images manually, replace this span with an `img` using a URL from the object data.
 */
function ImageStamp({ hue, label, small = false }: { hue: string; label: string; small?: boolean }) {
  return (
    <span
      className={small ? "image-stamp small" : "image-stamp"}
      role="img"
      aria-label={label}
      style={{ "--stamp-hue": hue } as CSSProperties}
    >
      <span />
    </span>
  );
}

/**
 * Small label/value statistic block.
 * To change its appearance manually, edit `.status` styles in `styles.css`.
 */
function Status({ label, value }: { label: string; value: string }) {
  return (
    <div className="status">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default App;
