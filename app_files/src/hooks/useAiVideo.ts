import { getAuthToken } from '@/lib/auth';
import { useCallback, useRef, useState } from 'react';

export type AiVideoProvider = 'fal' | 'higgsfield';

/**
 * Video generation is ASYNC (unlike image/audio): submitting returns a job,
 * then the hook polls until the clip is actually rendered. `status` walks:
 * idle → submitting → queued → in_progress → completed | failed.
 */
export type AiVideoStatus =
  | 'idle'
  | 'submitting'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed';

export interface UseAiVideoOptions {
  /**
   * Which backend renders the clip. Omit for auto:
   * - `higgsfield` when the workspace has connected its own Higgsfield
   *   account (BYOK — bills ZERO OverSkill credits; the workspace pays
   *   Higgsfield directly)
   * - `fal` otherwise (platform-billed Seedance on creator credits)
   */
  provider?: AiVideoProvider;
  /**
   * Model override. Omit to let the gateway pick a cost-balanced default
   * (fal: Seedance 1.0 Lite text-to-video, or the image-to-video variant
   * when `imageUrl` is set). Ask `GET /api/ai/video/providers` for the
   * BYOK model list — never invent model IDs.
   */
  model?: string;
  /**
   * Source frame for image-to-video (animating a storyboard keyframe).
   * Required for every Higgsfield model (all documented ones are i2v) and
   * for fal `*image-to-video` models.
   */
  imageUrl?: string;
  /** Clip length in seconds (model-dependent range, typically 2–15). */
  durationSeconds?: number;
  /** fal only: '480p' | '720p' | '1080p' | '4k' (model-dependent). */
  resolution?: string;
  /**
   * Dedup key. A repeat submit with the same key returns the SAME job —
   * no second upstream render, no second charge. Defaults to a fresh UUID
   * per generate() call, which protects the hook's own retries; pass a
   * stable domain key (e.g. `shot-${shotId}-take-${takeNumber}`) to also
   * dedup across reloads and repeat clicks.
   */
  idempotencyKey?: string;
  /**
   * fal only: estimates above the per-call credit ceiling are refused with
   * COST_CEILING_EXCEEDED unless this is true. Show the user the estimate
   * (POST /api/ai/video/estimate) before setting it.
   */
  confirmCost?: boolean;
  /** Provider-specific passthrough params (allowlisted server-side on fal). */
  params?: Record<string, unknown>;
  /** How often to poll job status. Default 5000ms. */
  pollIntervalMs?: number;
  /** Give up polling after this long. Default 600000ms (10 min). */
  maxPollMs?: number;
  onSuccess?: (result: GeneratedVideo) => void;
  onError?: (error: string) => void;
}

export interface GeneratedVideo {
  /** Job id — poll `GET /api/ai/video/status/{requestId}?provider=...`. */
  requestId: string;
  /** Backend that rendered the clip ('fal' | 'higgsfield'). */
  provider: string;
  /** Model that actually ran (may be the gateway default). */
  model: string;
  /** Terminal job status ('completed' | 'failed') once resolved. */
  status: string;
  /**
   * Playable URL once completed. fal clips are copied to OverSkill storage
   * (URL valid ~1h — re-poll status for a fresh one); Higgsfield URLs are
   * provider-hosted and may expire, so copy them to your own storage
   * promptly (the response `note` says so too).
   */
  videoUrl?: string;
  /** Credits charged to the creator. Always 0 on the BYOK path. */
  costCredits: number;
  /** True when the workspace's own provider account paid for the render. */
  byok?: boolean;
  durationSeconds?: number;
  resolution?: string;
  /** True when an idempotency key resolved to an existing job. */
  deduped?: boolean;
  /** Gateway/provider annotations (dropped params, URL-expiry warnings…). */
  note?: string;
  /** Failure detail when status === 'failed'. */
  error?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_POLL_MS = 600000; // 10 min — long 1080p/4k renders are slow
const MAX_CONSECUTIVE_POLL_FAILURES = 3; // gateway may ask us to re-poll (e.g. output pull retry)

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `vid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coerce an error field of unknown shape to a string — or undefined.
 * Upstream gateways have returned `{ error: { code, message } }` OBJECTS
 * (the Platform Proxy envelope); rendering that object into JSX crashes
 * React with minified error #31 (the 2026-07-08 Shot Review Studio page
 * crash). NEVER store a non-string in error state.
 */
function errorText(err: unknown): string | undefined {
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return undefined;
}

/** Gateway errors come as a string, `{ error: { message } }`, or a hint. */
function errorMessageFrom(data: Record<string, unknown>, fallback: string): string {
  const fromError = errorText(data.error);
  if (fromError) return fromError;
  if (typeof data.hint === 'string' && data.hint) return data.hint;
  return fallback;
}

/**
 * Hook for AI-powered video generation in your app.
 *
 * Routes through `POST /api/ai/video/generate` → the platform video gateway
 * (fal.ai Seedance, platform-billed) or the workspace's own connected
 * Higgsfield account (BYOK, zero platform credits). No API keys in client
 * code. Generation is ASYNC — the hook submits, then polls
 * `GET /api/ai/video/status/{id}` until the clip is done, exposing `status`
 * ('queued' | 'in_progress' | …) so the UI can show progress. `onSuccess`
 * fires only when the video is actually rendered.
 *
 * Provider selection (when `options.provider` is omitted) is auto:
 * - Workspace has a connected Higgsfield account → `higgsfield` (BYOK, free)
 * - Otherwise → `fal` (creator credits)
 *
 * Costs are real — a 5s fal clip runs ~40 credits on the default model and
 * hundreds on Seedance 2.0 at high resolutions. Use
 * `POST /api/ai/video/estimate` to show the user a price first.
 *
 * Usage:
 * ```tsx
 * function ShotRenderButton({ shot }: { shot: Shot }) {
 *   const { generate, status, video, loading, error } = useAiVideo({
 *     durationSeconds: 5,
 *     idempotencyKey: `shot-${shot.id}-take-${shot.nextTake}`,
 *     onSuccess: (v) => saveTake(shot.id, v.videoUrl!)
 *   });
 *
 *   return (
 *     <div>
 *       <button
 *         onClick={() => generate(shot.sceneDescription, { imageUrl: shot.keyframeUrl })}
 *         disabled={loading}
 *       >
 *         {loading ? `Rendering… (${status})` : 'Generate clip'}
 *       </button>
 *       {error && <p className="error">{error}</p>}
 *       {video?.videoUrl && <video src={video.videoUrl} controls />}
 *     </div>
 *   );
 * }
 * ```
 */
export function useAiVideo(options?: UseAiVideoOptions) {
  const [video, setVideo] = useState<GeneratedVideo | null>(null);
  const [status, setStatus] = useState<AiVideoStatus>('idle');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each generate()/reset() bumps the run id; a stale poll loop sees the
  // mismatch and stops touching state (covers re-submits and reset()).
  const runIdRef = useRef(0);

  const generate = useCallback(
    async (prompt: string, overrides?: UseAiVideoOptions): Promise<GeneratedVideo | null> => {
      const opts: UseAiVideoOptions = { ...options, ...overrides };
      const fail = (message: string): null => {
        setError(message);
        setStatus('failed');
        setLoading(false);
        opts.onError?.(message);
        return null;
      };

      if (!prompt || !prompt.trim()) {
        return fail('Prompt is required');
      }

      const runId = ++runIdRef.current;
      setLoading(true);
      setError(null);
      setVideo(null);
      setStatus('submitting');

      const token = getAuthToken();
      const headers = {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` })
      };

      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        // Always send a key — the server-side dedup only protects retries
        // when one is actually present.
        idempotency_key: opts.idempotencyKey ?? newIdempotencyKey()
      };
      if (opts.provider) body.provider = opts.provider;
      if (opts.model) body.model = opts.model;
      if (opts.imageUrl) body.image_url = opts.imageUrl;
      if (opts.durationSeconds !== undefined) body.duration_seconds = opts.durationSeconds;
      if (opts.resolution) body.resolution = opts.resolution;
      if (opts.confirmCost) body.confirm_cost = true;
      if (opts.params) body.params = opts.params;

      let submitted: Record<string, unknown>;
      try {
        const response = await fetch('/api/ai/video/generate', {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
        });
        const data: Record<string, unknown> = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
          throw new Error(errorMessageFrom(data, `Video generation failed (${response.status})`));
        }
        submitted = data;
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Unknown error');
      }

      if (runId !== runIdRef.current) return null; // superseded by a newer call

      const requestId = String(submitted.request_id || '');
      const provider = String(submitted.provider || opts.provider || 'fal');
      if (!requestId) {
        return fail('Video gateway did not return a request_id');
      }

      const toResult = (data: Record<string, unknown>): GeneratedVideo => ({
        requestId,
        provider: String(data.provider || provider),
        model: String(data.model ?? submitted.model ?? ''),
        status: String(data.status ?? ''),
        videoUrl: (data.video_url as string) || undefined,
        costCredits: Number(data.cost_credits ?? submitted.cost_credits ?? 0),
        byok: data.byok === true || submitted.byok === true || undefined,
        durationSeconds: (data.duration_seconds as number) ?? (submitted.duration_seconds as number) ?? undefined,
        resolution: (data.resolution as string) ?? (submitted.resolution as string) ?? undefined,
        deduped: submitted.deduped === true || undefined,
        note: (data.note as string) || (submitted.note as string) || undefined,
        // errorText (never a raw cast) — a `{ code, message }` object here
        // would flow into fail() → setError() → JSX and crash the page.
        error: errorText(data.error)
      });

      // A deduped retry may already be terminal — don't poll a done job.
      const submittedStatus = String(submitted.status || '');
      if (submittedStatus === 'completed' || submittedStatus === 'failed') {
        const result = toResult(submitted);
        setVideo(result);
        setStatus(submittedStatus as AiVideoStatus);
        setLoading(false);
        if (submittedStatus === 'completed') {
          opts.onSuccess?.(result);
          return result;
        }
        return fail(result.error || 'Video generation failed');
      }

      setStatus('queued');

      // ── Poll until the render is actually done ──
      const pollUrl =
        (submitted.poll as string) ||
        `/api/ai/video/status/${encodeURIComponent(requestId)}?provider=${provider}`;
      const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const maxPollMs = opts.maxPollMs ?? DEFAULT_MAX_POLL_MS;
      const deadline = Date.now() + maxPollMs;
      let consecutiveFailures = 0;

      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        if (runId !== runIdRef.current) return null;

        let data: Record<string, unknown>;
        try {
          const response = await fetch(pollUrl, { headers });
          data = await response.json().catch(() => ({}));
          if (!response.ok) {
            // Transient gateway hiccups (and "output pull failed; retry the
            // status poll") are expected — only give up after several in a row.
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
              return fail(errorMessageFrom(data, `Video status check failed (${response.status})`));
            }
            continue;
          }
        } catch (err) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            return fail(err instanceof Error ? err.message : 'Video status check failed');
          }
          continue;
        }
        consecutiveFailures = 0;
        if (runId !== runIdRef.current) return null;

        const jobStatus = String(data.status || '');
        if (jobStatus === 'completed') {
          const result = toResult(data);
          setVideo(result);
          setStatus('completed');
          setLoading(false);
          opts.onSuccess?.(result);
          return result;
        }
        if (jobStatus === 'failed') {
          const result = toResult(data);
          setVideo(result);
          return fail(result.error || 'Video generation failed');
        }
        // 'submitted' means fal hasn't started it yet — treat as queued.
        setStatus(jobStatus === 'in_progress' ? 'in_progress' : 'queued');
      }

      return fail(
        `Video generation timed out after ${Math.round(maxPollMs / 1000)}s — the job may still complete; poll ${pollUrl} to check`
      );
    },
    [options]
  );

  const reset = useCallback(() => {
    runIdRef.current += 1; // cancel any in-flight poll loop
    setVideo(null);
    setStatus('idle');
    setLoading(false);
    setError(null);
  }, []);

  return {
    generate,
    video,
    status,
    loading,
    error,
    reset
  };
}

export default useAiVideo;
