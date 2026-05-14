import {
  fallbackPlatformData,
  type FollowUpStatus,
  health,
  type ObjectClass,
  type ObjectComment,
  type ObservingTelescope,
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
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  fetchPlatformData,
  normalizeTransientObject,
  postObjectComment,
  postObservingTelescope,
  updateObjectInteraction,
  type ObjectInteractionUpdate,
} from "./api";

const navigation = [
  { label: "Dashboard", id: "dashboard" },
  { label: "Object List", id: "object-list" },
  { label: "Follow-up Queue", id: "follow-up-queue" },
  { label: "Team & Sharing", id: "team-sharing" },
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

/** Next follow-up step when using the row action (cycles stages; Archived is off the kanban but still reachable from the list). */
const FOLLOW_UP_CYCLE: Record<FollowUpStatus, FollowUpStatus> = {
  Archived: "To Do",
  "To Do": "Observing",
  Observing: "Analyzed",
  Analyzed: "Archived",
};

function isFollowUpTagActive(object: TransientObject) {
  return object.followUp === "To Do" || object.followUp === "Observing" || object.followUp === "Analyzed";
}

/** Objects shown on the Follow-up Queue board: the three active workflow lanes only (not Archived). */
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
 * The follow-up tag matches objects in an active workflow stage (To Do, Observing, or Analyzed), not Archived.
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

/** Sort key for Follow-up Queue: last user/follow-up/classification touch, then detection time. */
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

function kanbanTelescopeLabel(code: string, catalog: ObservingTelescope[]) {
  return catalog.find((entry) => entry.code === code)?.displayName ?? code;
}

/** Local date (yyyy-mm-dd) and time (HH:mm) parts for calendar + clock inputs. */
function splitRevisitLocal(iso: string | null) {
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
    }

    if (update.revisitAt !== undefined) {
      optimisticUpdate.revisitAt = update.revisitAt;
    }

    if (update.telescopeCodes !== undefined) {
      const codes = [
        ...new Set(
          update.telescopeCodes
            .map((c) => String(c).trim().toUpperCase().replace(/\s+/g, "_"))
            .filter(Boolean),
        ),
      ];
      optimisticUpdate.telescopeCodes = codes;
      optimisticUpdate.telescopeCode = codes[0] ?? null;
    }

    if (update.telescope !== undefined) {
      if (update.telescope === null || update.telescope === "") {
        optimisticUpdate.telescopeCodes = [];
        optimisticUpdate.telescopeCode = null;
      } else {
        const one = String(update.telescope)
          .trim()
          .toUpperCase()
          .replace(/\s+/g, "_");
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
          <span>Data credits: Lasair / LSST / Pan-STARRS</span>
          <span>GDPR-ready audit and export workflow</span>
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
          onInteraction={onInteraction}
          onTagFilterChange={onTagFilterChange}
          onSortFieldChange={onSortFieldChange}
          onSortDirectionToggle={onSortDirectionToggle}
          onRedoSnooze={onRedoSnooze}
        />
      );
    case "object-detail":
      return <ObjectDetail object={selectedObject} onInteraction={onInteraction} onPostComment={onPostComment} />;
    case "team-sharing":
      return <Collaboration teams={platformData.teams} />;
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
      <Panel title="Recent Activity Feed" eyebrow="Last 10 classifications">
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
      title="Filterable, sortable candidate table"
      copy="Designed for TanStack Table or AG-Grid integration when the backend is connected. This first version includes the full column model, smart filters, saved views, and bulk-action affordances."
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
  onInteraction,
  onRedoSnooze,
}: {
  object: TransientObject;
  index: number;
  redoIndex: number;
  snoozeRedo: SnoozeRedoState | null;
  onInteraction: InteractionHandler;
  onRedoSnooze: () => void;
}) {
  return (
    <>
      {snoozeRedo && redoIndex === index ? (
        <RedoRow object={snoozeRedo.object} exiting={snoozeRedo.exiting} onRedoSnooze={onRedoSnooze} />
      ) : null}
      <ObjectRow object={object} onInteraction={onInteraction} />
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
function ObjectRow({ object, onInteraction }: { object: TransientObject; onInteraction: InteractionHandler }) {
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
              onClick={() => chooseAction({ starred: !object.starred })}
              title="star"
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

/**
 * Detailed single-object analysis page.
 * To add tabs or more scientific panels manually, add new `Panel` blocks inside the `detail-grid`.
 */
function ObjectDetail({
  object,
  onInteraction,
  onPostComment,
}: {
  object: TransientObject;
  onInteraction: InteractionHandler;
  onPostComment: CommentPostHandler;
}) {
  const [draftComment, setDraftComment] = useState("");
  const [localComments, setLocalComments] = useState(object.comments);

  useEffect(() => {
    setLocalComments(object.comments);
  }, [object.comments, object.lasairId]);

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
      title={`${object.name} deep analysis workspace`}
      copy="A tabbed detail page brings together image stamps, coordinates, model transparency, classification history, annotations, and follow-up ownership."
    >
      <div className="detail-grid">
        <Panel title="Overview" eyebrow="Latest stamp carousel">
          <div className="stamp-row">
            {["Latest", "Previous", "Reference"].map((label, index) => (
              <ImageStamp key={label} hue={`${190 + index * 28}deg`} label={label} />
            ))}
          </div>
          <div className="summary-card">
            <Badge label={object.classification} tone={classColor[object.classification]} />
            <Progress value={object.confidence} />
            <p>
              AGN removed: <strong>{object.agnRemoved ? "Yes" : "No"}</strong>
            </p>
            <p>Quality flags: {object.qualityFlags.join(", ")}</p>
          </div>
        </Panel>

        <Panel title="Classification History" eyebrow="Probability evolution">
          <div className="timeline">
            {["Model scored initial alert", "Astronomer annotation added", "Follow-up status changed"].map(
              (event, index) => (
                <div key={event}>
                  <span>{index + 1}</span>
                  <p>{event}</p>
                </div>
              ),
            )}
          </div>
        </Panel>

        <Panel title="Images & Photometry" eyebrow="Lasair-ready">
          <div className="lightcurve" role="img" aria-label="Mock light curve">
            {[22, 35, 48, 62, 74, 67, 58, 45].map((point, index) => (
              <span key={`${point}-${index}`} style={{ height: `${point}%` }} />
            ))}
          </div>
        </Panel>

        <Panel title="Follow-up & Starred" eyebrow="Collaboration">
          <Status label="Status" value={object.followUp} />
          <Status label="Priority" value={object.priority} />
          <button type="button" onClick={() => onInteraction(object, { starred: !object.starred })}>
            {object.starred ? "Remove from starred" : "Add to starred"}
          </button>
          <button type="button" className="secondary" onClick={() => onInteraction(object, { followUp: "To Do" })}>
            Mark for follow-up
          </button>
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
 * Team and sharing page.
 * To change team cards manually, update the API/fallback `teams` data or add controls inside this component.
 */
function Collaboration({ teams }: { teams: PlatformData["teams"] }) {
  return (
    <Section
      id="team-sharing"
      eyebrow="Starred Objects & Team Sharing"
      title="Personal and shared candidate curation"
      copy="Teams can create collections, invite users by email or ORCID, and grant view, annotate, or classify permissions."
    >
      <div className="cards-three">
        {teams.map((team) => (
          <article className="collection-card" key={team.name}>
            <h3>{team.name}</h3>
            <p>{team.permission}</p>
            <div>
              <span>{team.members} members</span>
              <span>{team.collections} collections</span>
            </div>
          </article>
        ))}
      </div>
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
  const priorities = ["High", "Medium", "Low"] as const;
  const [revisitDate, setRevisitDate] = useState(() => splitRevisitLocal(object.revisitAt).date);
  const [revisitTime, setRevisitTime] = useState(() => splitRevisitLocal(object.revisitAt).time);
  const [telescopeCodesDraft, setTelescopeCodesDraft] = useState<string[]>(() => [...(object.telescopeCodes ?? [])]);
  const [pickTelescope, setPickTelescope] = useState("");
  const [newTelCode, setNewTelCode] = useState("");
  const [newTelName, setNewTelName] = useState("");

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
    const next = splitRevisitLocal(object.revisitAt);
    setRevisitDate(next.date);
    setRevisitTime(next.time);
  }, [object.lasairId, object.revisitAt]);

  useEffect(() => {
    setTelescopeCodesDraft([...(object.telescopeCodes ?? [])]);
    setPickTelescope("");
    setNewTelCode("");
    setNewTelName("");
  }, [object.lasairId, object.lastActionAt, (object.telescopeCodes ?? []).join("\u0001"), object.telescopeCode]);

  const applyRevisit = (): boolean => {
    if (!revisitDate) {
      return false;
    }
    const timePart = revisitTime || "09:00";
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

  const appendPickToDraft = async () => {
    if (!pickTelescope) {
      return;
    }
    if (pickTelescope === KANBAN_ADD_TELESCOPE_SELECT_VALUE) {
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
      return;
    }
    if (!telescopeCodesDraft.includes(pickTelescope)) {
      setTelescopeCodesDraft((d) => [...d, pickTelescope]);
    }
    setPickTelescope("");
  };

  const saveTelescopeList = (trigger: HTMLElement) => {
    onInteraction(object, { telescopeCodes: [...telescopeCodesDraft] });
    closeKanbanDetails(trigger);
  };

  const clearTelescopeList = (trigger: HTMLElement) => {
    setTelescopeCodesDraft([]);
    setPickTelescope("");
    setNewTelCode("");
    setNewTelName("");
    onInteraction(object, { telescopeCodes: [] });
    closeKanbanDetails(trigger);
  };

  const addToCardDisabled =
    !pickTelescope || (pickTelescope === KANBAN_ADD_TELESCOPE_SELECT_VALUE && !newTelCode.trim());

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
          <details className="kanban-tool" data-kanban-tool="revisit" onToggle={onKanbanToolToggle}>
            <summary className="kanban-icon-button" aria-label="Revisit reminder" title="Revisit reminder">
              <ActionIcon name="clock" />
            </summary>
            <div className="kanban-popover">
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
      <p className="kanban-popover-hint kanban-telescope-hint">Add facilities to this card (no duplicate codes). Save commits the list; Clear removes all.</p>
              <ul className="kanban-telescope-chips" aria-label="Telescopes on this card">
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
                    setPickTelescope(event.target.value);
                    if (event.target.value !== KANBAN_ADD_TELESCOPE_SELECT_VALUE) {
                      setNewTelCode("");
                      setNewTelName("");
                    }
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
                  />
                  <input
                    placeholder="Display name (optional)"
                    value={newTelName}
                    onChange={(event) => setNewTelName(event.target.value)}
                  />
                </div>
              ) : null}
              <div className="kanban-telescope-pick-actions">
                <button
                  type="button"
                  className="secondary kanban-telescope-add-btn"
                  disabled={addToCardDisabled}
                  onClick={() => void appendPickToDraft()}
                >
                  Add to card
                </button>
              </div>
              <div className="kanban-popover-actions">
                <button type="button" onClick={(event) => saveTelescopeList(event.currentTarget)}>
                  Save
                </button>
                <button type="button" className="secondary" onClick={(event) => clearTelescopeList(event.currentTarget)}>
                  Clear
                </button>
              </div>
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
 * Kanban-style follow-up queue: three lanes (To Do, Observing, Analyzed). Archived status is only from the object list.
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
  const lanes = ["To Do", "Observing", "Analyzed"] as const;
  const [dragOverLane, setDragOverLane] = useState<FollowUpStatus | null>(null);

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
    };
  }, []);

  const boardObjects = useMemo(() => objects.filter((object) => isOnFollowUpBoard(object)), [objects]);

  const handleDragStart = (event: DragEvent<HTMLDivElement>, lasairId: string) => {
    event.dataTransfer.setData("text/lasair-id", lasairId);
    event.dataTransfer.effectAllowed = "move";
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
      title="Kanban-style observing workflow"
      copy="Set priority (High / Medium / Low), a revisit reminder, and an observing telescope on each card. New telescopes are saved to PostgreSQL. Drag cards between lanes to update workflow status."
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
            <h3>{lane}</h3>
            {boardObjects
              .filter((object) => object.followUp === lane)
              .sort((a, b) => getObjectActionSortTime(b) - getObjectActionSortTime(a))
              .map((object) => (
                <div
                  className="task-card task-card--draggable"
                  key={object.lasairId}
                  draggable
                  onDragStart={(event) => handleDragStart(event, object.lasairId)}
                  onDragEnd={() => setDragOverLane(null)}
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
