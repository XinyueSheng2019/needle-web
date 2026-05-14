import {
  fallbackPlatformData,
  type FollowUpStatus,
  type ObjectComment,
  type ObservingTelescope,
  type PlatformData,
  type TransientObject,
} from "./data";

export function normalizeTransientObject(object: TransientObject): TransientObject {
  const row = object as TransientObject & {
    revisit_at?: string | null;
    telescope?: string | null;
    telescope_codes?: string[] | null;
  };
  const fromCamel = object.telescopeCodes;
  const fromSnake = row.telescope_codes;
  /** Prefer a non-empty list; treat empty camel array as missing so snake_case payloads still win. */
  const rawList =
    (Array.isArray(fromCamel) && fromCamel.length > 0 ? fromCamel : null) ??
    (Array.isArray(fromSnake) && fromSnake.length > 0 ? fromSnake : null) ??
    (Array.isArray(fromCamel) ? fromCamel : Array.isArray(fromSnake) ? fromSnake : []);
  let telescopeCodes: string[] = [];
  if (rawList.length > 0) {
    telescopeCodes = [...new Set(rawList.map((c) => String(c).trim().toUpperCase().replace(/\s+/g, "_")).filter(Boolean))];
  } else if (object.telescopeCode ?? row.telescope) {
    const one = String(object.telescopeCode ?? row.telescope)
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");
    if (one) {
      telescopeCodes = [one];
    }
  }
  return {
    ...object,
    revisitAt: object.revisitAt ?? row.revisit_at ?? null,
    telescopeCodes,
    telescopeCode: telescopeCodes[0] ?? object.telescopeCode ?? row.telescope ?? null,
  };
}

/**
 * Loads dashboard data from the backend API.
 * If the API/database is unavailable, it returns local fallback data so the prototype still works.
 * To change the data source manually, edit the `/api/dashboard` URL or remove the fallback branch.
 */
export async function fetchPlatformData(): Promise<{ data: PlatformData; source: "database" | "fallback" }> {
  try {
    const response = await fetch("/api/dashboard");

    if (!response.ok) {
      throw new Error(`Dashboard API returned ${response.status}`);
    }

    const payload = (await response.json()) as PlatformData;
    const data: PlatformData = {
      ...payload,
      objects: payload.objects.map(normalizeTransientObject),
    };
    return { data: { ...fallbackPlatformData, ...data }, source: "database" };
  } catch (error) {
    console.warn("Using local fallback data because the database API is unavailable.", error);
    return { data: fallbackPlatformData, source: "fallback" };
  }
}

export type ObjectInteractionUpdate = {
  starred?: boolean;
  promoted?: boolean;
  snoozed?: boolean;
  followUp?: FollowUpStatus;
  priority?: "High" | "Medium" | "Low";
  revisitAt?: string | null;
  telescope?: string | null;
  telescopeCodes?: string[];
};

/**
 * Persists one object's Star, Snooze, or Follow-up change through the backend API.
 * To support a new interaction manually, add the field to `ObjectInteractionUpdate` and handle it on the server.
 */
export async function updateObjectInteraction(
  lasairId: string,
  update: ObjectInteractionUpdate,
): Promise<TransientObject> {
  const response = await fetch(`/api/objects/${encodeURIComponent(lasairId)}/interactions`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(update),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { detail?: string; error?: string } | null;
    throw new Error(error?.detail ?? error?.error ?? `Interaction API returned ${response.status}`);
  }

  const payload = (await response.json()) as TransientObject;
  return normalizeTransientObject(payload);
}

/**
 * Saves a new comment for one object through the backend API.
 * To add richer comment fields manually, extend the request body and database insert on the server.
 */
export async function postObjectComment(lasairId: string, body: string): Promise<ObjectComment> {
  const response = await fetch(`/api/objects/${encodeURIComponent(lasairId)}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { detail?: string; error?: string } | null;
    throw new Error(error?.detail ?? error?.error ?? `Comment API returned ${response.status}`);
  }

  return response.json() as Promise<ObjectComment>;
}

/**
 * Registers a new observing telescope code for the follow-up queue.
 * Codes are normalized to uppercase; use the returned `code` when PATCHing an object interaction.
 */
export async function postObservingTelescope(code: string, displayName?: string): Promise<ObservingTelescope> {
  const response = await fetch("/api/telescopes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code, displayName }),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { detail?: string; error?: string } | null;
    throw new Error(error?.detail ?? error?.error ?? `Telescope API returned ${response.status}`);
  }

  return response.json() as Promise<ObservingTelescope>;
}
