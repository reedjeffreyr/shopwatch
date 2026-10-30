// PLATFORM-MANAGED: seed HOST-owned checkout email/name from an opt-in.
//
// WHY THIS EXISTS (Northline / joaMke, 2026-09-01): Jason filled an opt-in
// (email / first / last), landed on checkout, and the greeting used his
// name — but the host email/name inputs were empty. The page already read
// `?email=` / `?first=` / `?last=` (and `northline_lead_v1` in
// sessionStorage) for copy. The inputs never got those values. Card and
// Address stay in js.whop.cloud frames and MUST NOT be written here.
//
// This is a generated-app template gap, not a platform product and not a
// Whop limitation on host fields. Seed when we already know the person;
// skip when we don't. Apps without an opt-in stay a blank form.
//
// Name sources (later wins): session/storage the opt-in already wrote, then
// the hash, then the query string. Email is SAME-TAB STORAGE ONLY — a
// shareable `?email=attacker@…` must not become buyer.email on
// /api/whop/confirm. The opt-in already writes the lead to session
// (funnel_lead / northline_lead_v1 / …). Do not invent a required funnel step.
//
// This module is DEPENDENCY-FREE (no React, no overskill-sdk) so the
// vitest suite can execute the REAL functions.

export interface HostOwnedBillingPrefill {
  email?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
  removeItem?(key: string): void;
  length?: number;
  key?(index: number): string | null;
}

export interface HostOwnedBillingPrefillSource {
  search?: string;
  hash?: string;
  storage?: StorageLike | null;
}

/** Two-step funnel template key (`funnels/two-step-checkout`). */
export const FUNNEL_LEAD_STORAGE_KEY = "funnel_lead";

export const HOST_OWNED_BILLING_STORAGE_KEYS = [
  FUNNEL_LEAD_STORAGE_KEY,
  "overskill_lead",
  "overskill_optin",
  "checkout_email",
] as const;

const EMAIL_KEYS = ["email", "buyer_email", "buyerEmail"] as const;
const FIRST_KEYS = [
  "first",
  "first_name",
  "firstName",
  "fname",
  "given_name",
  "givenName",
] as const;
const LAST_KEYS = [
  "last",
  "last_name",
  "lastName",
  "lname",
  "family_name",
  "familyName",
] as const;
const NAME_KEYS = ["name", "full_name", "fullName"] as const;
const STORAGE_KEY_HINT = /lead|opt-?in|optin|buyer/i;

export function compactPrefillString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function hasHostOwnedBillingPrefill(
  prefill: HostOwnedBillingPrefill | null | undefined
): boolean {
  if (!prefill) return false;
  return Boolean(prefill.email || prefill.firstName || prefill.lastName || prefill.name);
}

export function splitFullName(name: string): {
  firstName?: string;
  lastName?: string;
} {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function joinPrefillName(
  firstName?: string,
  lastName?: string
): string | undefined {
  const joined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return joined || undefined;
}

export function compactHostOwnedBillingPrefill(
  input: HostOwnedBillingPrefill
): HostOwnedBillingPrefill {
  const next: HostOwnedBillingPrefill = {};
  const email = compactPrefillString(input.email);
  const firstName = compactPrefillString(input.firstName);
  const lastName = compactPrefillString(input.lastName);
  const name = compactPrefillString(input.name);
  if (email) next.email = email;
  if (firstName) next.firstName = firstName;
  if (lastName) next.lastName = lastName;
  if (name) next.name = name;
  return next;
}

export function normalizeHostOwnedBillingPrefill(
  input: HostOwnedBillingPrefill
): HostOwnedBillingPrefill {
  const email = compactPrefillString(input.email);
  let firstName = compactPrefillString(input.firstName);
  let lastName = compactPrefillString(input.lastName);
  let name = compactPrefillString(input.name);
  if (firstName && lastName) {
    // Both parts known — join them. Do not keep a one-word name a
    // greeting-only `?first=` synthesized before merge.
    name = joinPrefillName(firstName, lastName);
  } else if (!name) {
    name = joinPrefillName(firstName, lastName);
  } else {
    const split = splitFullName(name);
    firstName = firstName || split.firstName;
    lastName = lastName || split.lastName;
    if (firstName && lastName) name = joinPrefillName(firstName, lastName);
  }
  const next: HostOwnedBillingPrefill = {};
  if (email) next.email = email;
  if (firstName) next.firstName = firstName;
  if (lastName) next.lastName = lastName;
  if (name) next.name = name;
  return next;
}

function pickRecordValue(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = compactPrefillString(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function prefillFromRecord(
  raw: unknown
): HostOwnedBillingPrefill {
  if (typeof raw === "string") {
    const email = compactPrefillString(raw);
    return email && email.includes("@") ? { email } : {};
  }
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  return compactHostOwnedBillingPrefill({
    email: pickRecordValue(record, EMAIL_KEYS),
    firstName: pickRecordValue(record, FIRST_KEYS),
    lastName: pickRecordValue(record, LAST_KEYS),
    name: pickRecordValue(record, NAME_KEYS),
  });
}

function firstSearchParam(
  params: URLSearchParams,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = compactPrefillString(params.get(key));
    if (value) return value;
  }
  return undefined;
}

export function prefillFromSearchParams(
  params: URLSearchParams
): HostOwnedBillingPrefill {
  return compactHostOwnedBillingPrefill({
    email: firstSearchParam(params, EMAIL_KEYS),
    firstName: firstSearchParam(params, FIRST_KEYS),
    lastName: firstSearchParam(params, LAST_KEYS),
    name: firstSearchParam(params, NAME_KEYS),
  });
}

export function parsePrefillSearch(raw: string | undefined | null): URLSearchParams {
  if (!raw) return new URLSearchParams();
  let value = raw;
  if (value.startsWith("#") || value.startsWith("?")) value = value.slice(1);
  const queryAt = value.indexOf("?");
  if (queryAt >= 0) value = value.slice(queryAt + 1);
  return new URLSearchParams(value);
}

function mergePrefill(
  ...parts: HostOwnedBillingPrefill[]
): HostOwnedBillingPrefill {
  const merged: HostOwnedBillingPrefill = {};
  for (const part of parts) {
    if (part.email) merged.email = part.email;
    if (part.firstName) merged.firstName = part.firstName;
    if (part.lastName) merged.lastName = part.lastName;
    if (part.name) merged.name = part.name;
  }
  return normalizeHostOwnedBillingPrefill(merged);
}

function readStorageKeys(storage: StorageLike): string[] {
  const keys = new Set<string>(HOST_OWNED_BILLING_STORAGE_KEYS);
  const length = typeof storage.length === "number" ? storage.length : 0;
  if (storage.key && length > 0) {
    for (let i = 0; i < length; i += 1) {
      const key = storage.key(i);
      if (key && STORAGE_KEY_HINT.test(key)) keys.add(key);
    }
  }
  return Array.from(keys);
}

export function prefillFromStorage(
  storage: StorageLike | null | undefined
): HostOwnedBillingPrefill {
  if (!storage) return {};
  let merged: HostOwnedBillingPrefill = {};
  try {
    for (const key of readStorageKeys(storage)) {
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch {
        continue;
      }
      if (!raw) continue;
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // plain email string (captureCheckoutEmail)
      }
      merged = mergePrefill(merged, prefillFromRecord(parsed));
    }
  } catch {
    return merged;
  }
  return merged;
}

function defaultSource(): HostOwnedBillingPrefillSource {
  if (typeof window === "undefined") return {};
  let storage: StorageLike | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return {
    search: window.location.search,
    hash: window.location.hash,
    storage,
  };
}

function withoutEmail(prefill: HostOwnedBillingPrefill): HostOwnedBillingPrefill {
  const { email: _email, ...rest } = prefill;
  return rest;
}

/**
 * Read host-owned billing identity we already know. Empty when the
 * checkout opened with no opt-in params / storage — that is the
 * traditional blank form, on purpose.
 *
 * Email is never taken from query or hash. Those travel with a shared
 * link; confirm sends host email as buyer.email, and anonymous
 * fulfillment still matches that address to an AppUser.
 */
export function readHostOwnedBillingPrefill(
  source?: HostOwnedBillingPrefillSource
): HostOwnedBillingPrefill {
  const resolved = source ?? defaultSource();
  const fromStorage = prefillFromStorage(resolved.storage);
  return mergePrefill(
    withoutEmail(fromStorage),
    withoutEmail(prefillFromSearchParams(parsePrefillSearch(resolved.hash))),
    withoutEmail(prefillFromSearchParams(parsePrefillSearch(resolved.search))),
    fromStorage.email ? { email: fromStorage.email } : {}
  );
}
