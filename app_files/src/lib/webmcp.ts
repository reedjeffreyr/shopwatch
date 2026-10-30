// PLATFORM-MANAGED: webmcp.ts — the ONLY place this app talks to the browser's
// WebMCP tool registry. Page code never calls the browser API directly; it
// mounts a platform component (today: `WebMcpCheckoutTools`) which builds its
// tools and hands them here.
//
// THE API SHAPE IS `document.modelContext`, NOT `navigator.modelContext`.
// The W3C draft (webmachinelearning.github.io/webmcp) puts `modelContext` on a
// partial `Document` interface and declares tools ONE AT A TIME through
// `registerTool(tool, { signal })`. The earlier Chrome-blog shape
// (`navigator.modelContext.provideContext({ tools })`) is the one overskill.com's
// own public Stimulus controller still carries for its marketing pages — do NOT
// copy that here. If a browser exposes only the old shape we register NOTHING:
// a checkout is money, and a half-understood registry is not somewhere to guess.
//
// Everything below is defensive by construction:
//   - No WebMCP support (the overwhelmingly common case, and every SSR/test
//     environment) is a SILENT no-op. Never a throw, never a console error, and
//     never a reason an app fails to boot.
//   - A `registerTool` that throws is logged once per tool and skipped; the
//     remaining tools still register and the app is untouched.
//   - Unregistration happens BOTH ways: the caller's AbortSignal (the spec's own
//     mechanism) and an explicit `unregisterTool` sweep, because an
//     implementation that ignores one must not leave a dead tool advertised.
//
// A tool's `execute` returns a plain JSON-serializable value — the spec
// stringifies whatever it resolves to. So a FAILURE IS A RETURNED VALUE, never a
// thrown error: an agent can read `{ ok: false, error, message }` and decide,
// where a rejection is just an opaque failure it may retry blindly.

export interface WebMcpToolAnnotations {
  /** The tool only reads page state. */
  readOnlyHint?: boolean;
  /** The result embeds content this page does not control (creator copy, vendor error text). */
  untrustedContentHint?: boolean;
  /** Significant, real-world, or non-reversible — e.g. taking money. */
  consequentialHint?: boolean;
}

/** A confirm-style prompt shown to the PERSON, not the agent. */
export interface WebMcpUserInteractionRequest {
  type: "confirm";
  title: string;
  description: string;
  action: string;
}

export type WebMcpRequestUserInteraction = (
  request: WebMcpUserInteractionRequest
) => unknown;

/** Second argument the registry passes to `execute`. */
export interface WebMcpExecuteOptions {
  signal?: AbortSignal;
  requestUserInteraction?: WebMcpRequestUserInteraction;
  client?: { requestUserInteraction?: WebMcpRequestUserInteraction };
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute: (
    input: Record<string, unknown>,
    options?: WebMcpExecuteOptions
  ) => Promise<unknown> | unknown;
}

export interface WebMcpModelContext {
  registerTool?: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => unknown;
  requestUserInteraction?: WebMcpRequestUserInteraction;
}

/** Anything carrying a `modelContext` — `document` in a browser, a stub in tests. */
export interface WebMcpHost {
  modelContext?: WebMcpModelContext | null;
}

function defaultHost(): WebMcpHost | null {
  return typeof document === "undefined" ? null : (document as unknown as WebMcpHost);
}

/**
 * The live registry, or null when this browser has no usable WebMCP.
 * "Usable" means `registerTool` — an object with only the retired bulk API is
 * deliberately treated as absent (see the header).
 */
export function webMcpModelContext(
  host: WebMcpHost | null = defaultHost()
): WebMcpModelContext | null {
  try {
    const context = host?.modelContext;
    if (!context || typeof context.registerTool !== "function") return null;
    return context;
  } catch {
    // Reading the property threw (hardened/instrumented environment).
    return null;
  }
}

export function webMcpSupported(host: WebMcpHost | null = defaultHost()): boolean {
  return webMcpModelContext(host) !== null;
}

/**
 * Register a tool set. Returns an idempotent unregister function.
 *
 * Registration failure NEVER propagates: a browser-side agent affordance must
 * not be able to take the page down.
 */
export function registerWebMcpTools(
  tools: WebMcpTool[],
  options: { signal?: AbortSignal; host?: WebMcpHost | null } = {}
): () => void {
  const host = options.host === undefined ? defaultHost() : options.host;
  const context = webMcpModelContext(host);
  if (!context || !tools.length) return () => {};

  const registered: string[] = [];
  for (const tool of tools) {
    try {
      context.registerTool!(tool, options.signal ? { signal: options.signal } : undefined);
      registered.push(tool.name);
    } catch (error) {
      console.warn(`[WebMCP] registerTool('${tool.name}') failed:`, error);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (typeof context.unregisterTool !== "function") return;
    for (const name of registered) {
      try {
        context.unregisterTool(name);
      } catch {
        // Already released by the AbortSignal, or never accepted. Either way
        // the tool is gone, which is the outcome we wanted.
      }
    }
  };
}

/**
 * Ask the PERSON to approve a consequential action.
 *
 * FAILS CLOSED, deliberately. This gate exists so an agent can never take money
 * on its own, so every uncertain outcome is a refusal:
 *   - no `requestUserInteraction` in this browser  → false
 *   - the call throws (including a shape mismatch)  → false
 *   - it resolves to anything other than an explicit approval → false
 *
 * The draft spec has been written both ways (a descriptor object on the
 * registry, and a callback handed to `execute`). We send the descriptor to
 * whichever location exists; an implementation that wanted a callback throws,
 * and a refusal is the safe answer — the shopper can always press the page's
 * own Pay button.
 */
export async function requestUserApproval(
  request: WebMcpUserInteractionRequest,
  options: WebMcpExecuteOptions | undefined,
  host: WebMcpHost | null = defaultHost()
): Promise<boolean> {
  const ask =
    options?.requestUserInteraction ||
    options?.client?.requestUserInteraction ||
    webMcpModelContext(host)?.requestUserInteraction;
  if (typeof ask !== "function") return false;

  try {
    const answer = await ask(request);
    if (answer === true) return true;
    if (answer && typeof answer === "object") {
      const record = answer as Record<string, unknown>;
      return record.confirmed === true || record.accepted === true;
    }
    return false;
  } catch (error) {
    console.warn("[WebMCP] requestUserInteraction failed:", error);
    return false;
  }
}

export interface WebMcpRefusal {
  ok: false;
  error: string;
  message: string;
  [key: string]: unknown;
}

/** A failure the agent can READ. Never throw out of `execute`. */
export function webMcpRefusal(
  error: string,
  message: string,
  extra: Record<string, unknown> = {}
): WebMcpRefusal {
  return { ok: false, error, message, ...extra };
}

export function webMcpResult<T extends Record<string, unknown>>(
  payload: T
): T & { ok: true } {
  return { ok: true, ...payload };
}
