import React from 'react';
import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Error handling utilities
export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function handleError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  
  if (error instanceof Error) {
    return new AppError(error.message, 'UNKNOWN_ERROR', 500);
  }
  
  return new AppError('An unexpected error occurred', 'UNKNOWN_ERROR', 500);
}

// Async utilities
export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function retry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (retries === 0) throw error;
    await sleep(delay);
    return retry(fn, retries - 1, delay * 2);
  }
}

// Date utilities

/**
 * True for a DATE-ONLY value: `YYYY-MM-DD` with no time part.
 *
 * The entity layer has two distinct column types
 * (AppTableColumn::COLUMN_TYPES): `date` stores "2026-12-25", `datetime`
 * stores a full timestamp. They need OPPOSITE parsing rules, and the value's
 * own shape is what tells them apart — a `date` column never carries a time,
 * a `datetime` column always does. No schema lookup is needed at the display
 * layer, so this stays a pure string test.
 */
export function isDateOnly(value: Date | string): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

/**
 * Parse a date-only value as LOCAL midnight.
 *
 * A calendar date is not an instant — "2026-12-25" is the same Christmas in
 * every timezone. `new Date("2026-12-25")` is specified to parse the date-only
 * form as UTC midnight, so formatting it in any negative-offset zone renders
 * the PREVIOUS day: a stored 2026-12-25 shown as "Dec 24, 2026" to every
 * viewer in the Americas. Building the Date from its parts pins it to local
 * midnight instead, so the rendered day always equals the stored day.
 */
export function parseDateOnly(value: string): Date {
  const [y, m, d] = value.trim().split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Parse a server timestamp as UTC.
 *
 * Backend timestamps are UTC. A bare string like "2026-05-13 00:18:31"
 * (no timezone designator) is parsed by `new Date()` as LOCAL time, which
 * shifts the instant by the viewer's timezone offset and makes "today" /
 * "this week" counts off by one day. parseUTC normalizes such values to UTC.
 *
 * - Date input is returned as-is.
 * - DATE-ONLY strings ("YYYY-MM-DD") have no instant to normalize and are
 *   resolved to LOCAL midnight via parseDateOnly, so the calendar day
 *   survives display. See that function for why UTC midnight is wrong here.
 * - Strings that already carry a timezone (`Z`, `+/-HH:MM`, or the short
 *   Postgres form `+/-HH` / `+/-HHMM`) are parsed natively (unambiguous).
 * - Naive strings ("YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS") are
 *   treated as UTC by appending `Z` (after normalizing the space separator).
 *
 * Always use this for server-timestamp parsing and date math; only format
 * to the viewer's local time at the moment of display.
 */
export function parseUTC(ts?: Date | string | null): Date {
  if (ts instanceof Date) return ts;
  // NOTHING TO PARSE -> an explicit Invalid Date, so callers can test
  // isNaN(d.getTime()) and get a reliable answer. Before this, a nullish or
  // blank value fell through to `new Date("nullZ")` / `new Date("Z")`, which
  // is ALSO an Invalid Date but only by accident, and the accident is what
  // made it easy to miss that formatDate had no guard at all.
  if (ts === null || ts === undefined) return new Date(NaN);
  const s = String(ts).trim();
  if (s === '') return new Date(NaN);
  // DATE-ONLY is checked FIRST, and the order is load-bearing: the offset
  // pattern below has a `[+-]\d{2}` arm that matches the trailing "-25" of a
  // bare "2026-12-25", so a date-only string used to take the "already has a
  // timezone" branch and resolve to UTC midnight — one day early once
  // formatted in any western zone. A calendar date has no instant to pin.
  if (isDateOnly(s)) return parseDateOnly(s);
  // Already has an explicit timezone — Z, +/-HH:MM, or the short Postgres
  // form +/-HH (and +/-HHMM). Trailing minutes optional. Unambiguous.
  if (/[zZ]$|[+-]\d{2}(:?\d{2})?$/.test(s)) return new Date(s);
  // Naive timestamp: normalize the space separator and pin to UTC.
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  return new Date(`${iso}Z`);
}

// Format utilities

/**
 * Render a `date` or `datetime` value for display.
 *
 * parseUTC routes date-only values to local midnight, so a `date` column
 * renders the exact day it stores, while a `datetime` column still renders
 * the viewer's local time for the stored UTC instant.
 */
export function formatDate(date?: Date | string | null): string {
  // An optional column is NULL far more often than it is malformed, and a
  // missing date must never be able to take down the page that renders it.
  // Measured on app 399 (staging, 2026-08-25): POST /api/entities/member with
  // join_date: "" returns 201 and correctly stores NULL — the documented
  // #5059 blank-to-NULL behaviour — and the very next /dashboard render died
  // behind the React error boundary with "Something went wrong". No console
  // error and no pageerror: the boundary swallowed both, so the only symptom
  // anyone saw was that sentence, while every API call on the page returned
  // 200. Intl.DateTimeFormat#format THROWS RangeError("Invalid time value")
  // on an Invalid Date; it does not degrade.
  //
  // '' rather than a placeholder like '—': the surrounding copy usually
  // supplies its own label ("Joined {formatDate(...)}"), and every formatter
  // the generator writes for itself already returns '' for absent input.
  const d = parseUTC(date);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(d);
}

export function formatCurrency(amount?: number | null): string {
  // Same family as formatDate above, one step less severe: this never threw,
  // it rendered. An undefined amount produced the literal "$NaN" on the page,
  // and a null one produced "$0.00" — which is worse, because it looks like a
  // real price of zero rather than a missing one.
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    // Stated explicitly rather than inherited from the currency's default:
    // money keeps its cents. Rendering a stored 31337.55 as "$31,338" is
    // silent precision loss, and it is the display layer — not the data —
    // that drops it, so a total on screen stops reconciling with the total
    // in the database.
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}
