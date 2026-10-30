import { getAuthToken } from '@/lib/auth';
import { useState, useCallback } from 'react';

export type AiImageModel =
  | 'gpt-image-2'
  | 'gpt-image-1.5'
  | 'gemini-3-pro-image'
  | 'gemini-3.1-flash-image'
  | 'imagen-4.0-fast-generate-001'
  | 'flux-2-klein-9b';

export type AiImageFormat = 'webp' | 'png' | 'jpeg';

export interface UseAiImageOptions {
  /** Model override. Omit to let the gateway auto-select based on prompt intent. */
  model?: AiImageModel;
  /** Output size (provider-dependent). Default '1024x1024'. */
  size?: '1024x1024' | '1536x1024' | '1024x1536' | '2048x2048';
  /** Quality hint. 'auto' (default) lets the provider pick. */
  quality?: 'low' | 'medium' | 'high' | 'auto';
  /**
   * Request transparent background. ONLY supported on `gpt-image-1.5` —
   * gpt-image-2 does not support transparency. The gateway auto-switches
   * `gpt-image-2 + transparent: true` to `gpt-image-1.5` and surfaces a
   * `note:` field on the response. Other models reject transparent:true.
   */
  transparent?: boolean;
  /** Output format. Default 'webp'. Transparent requests auto-upgrade to 'png'. */
  format?: AiImageFormat;
  /** Aspect ratio hint — Gemini / Imagen only (e.g. '16:9', '9:16', '1:1'). */
  aspectRatio?: string;
  /** Optional style hint passed through where the provider supports it. */
  style?: string;
  onSuccess?: (result: GeneratedImage) => void;
  onError?: (error: string) => void;
}

/** Per-call options for identity-preserving image edits (see `edit`). */
export interface EditImageOptions {
  /**
   * How faithfully to preserve the input subject's features (faces, objects,
   * the exact car/room you uploaded). Default 'high' — the whole point of an
   * edit is to keep the original and only change what the prompt asks.
   */
  inputFidelity?: 'high' | 'low';
  /**
   * Optional mask (base64 / data-URL PNG). Fully-transparent pixels mark the
   * region to edit; opaque pixels are preserved. Applied to the first image.
   */
  mask?: string;
  /** Model override — only `gpt-image-2` (default) / `gpt-image-1.5` can edit. */
  model?: 'gpt-image-2' | 'gpt-image-1.5';
  /** Output size. Omit to preserve the input aspect ratio ('auto'). */
  size?: string;
  /** Output format. Default 'webp'. */
  format?: AiImageFormat;
  /** Transparent background (forces gpt-image-1.5). */
  transparent?: boolean;
}

export interface GeneratedImage {
  /** Hosted URL (provider returns one) — preferred src. */
  url?: string;
  /** Base64-encoded image data (provider returns inline bytes). */
  image?: string;
  /** Final model the gateway actually used (may differ from request — e.g. auto-switch on transparent). */
  model: string;
  /** Echoed size. */
  size?: string;
  /** Output format (webp / png / jpeg). */
  format?: AiImageFormat;
  /** Some providers (gpt-image-*) rewrite the prompt for better outputs. */
  revisedPrompt?: string;
  /** Set when the gateway substituted the requested model — e.g. auto-switched gpt-image-2 → gpt-image-1.5 for transparent backgrounds, or edit-mode model substitution. */
  note?: string;
  /** True when the result came from image-EDIT mode (the reference image was used). */
  edited?: boolean;
  /** How many reference images the edit actually used. */
  inputImages?: number;
  /** Wall-clock latency reported by the worker. */
  elapsedMs: number;
}

/**
 * Parse a `/api/ai/image` response body without throwing on a non-JSON body.
 *
 * The worker always returns JSON, but the EDGE in front of it can return a
 * NON-JSON error page — most commonly Cloudflare's own rate-limit challenge
 * ("error code: 1015") or a 502/gateway HTML page. A naive `response.json()`
 * then throws `SyntaxError: Unexpected token 'e' ... is not valid JSON`, which
 * is what the customer saw ("Reveal failed: Unexpected token 'e' ..."). We fall
 * back to reading the text body and returning a clean, friendly error instead.
 */
async function parseImageResponse(
  response: Response
): Promise<{ ok: boolean; data: Record<string, unknown>; friendlyError?: string }> {
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    // Non-JSON body (Cloudflare 1015 rate-limit / gateway HTML / empty).
    const rateLimited =
      response.status === 429 || /error code: 1015|rate limit/i.test(raw);
    const friendlyError = rateLimited
      ? 'Too many image requests right now — please wait a moment and try again.'
      : `The image service is temporarily unavailable (status ${response.status}). Please try again shortly.`;
    return { ok: false, data: {}, friendlyError };
  }
  return { ok: response.ok, data };
}

function toGeneratedImage(data: Record<string, unknown>): GeneratedImage {
  return {
    url: data.url as string | undefined,
    image: data.image as string | undefined,
    model: data.model as string,
    size: data.size as string | undefined,
    format: data.format as AiImageFormat | undefined,
    revisedPrompt: data.revised_prompt as string | undefined,
    note: data.note as string | undefined,
    edited: data.edited as boolean | undefined,
    inputImages: data.input_images as number | undefined,
    elapsedMs: data.elapsed_ms as number
  };
}

/**
 * Hook for AI-powered image generation AND editing in your app.
 *
 * Routes through `/api/ai/image` → Cloudflare AI Gateway → provider.
 * Unified billing, caching, observability. No API keys in client code.
 *
 * `generate(prompt)` — TEXT-TO-IMAGE. Default model selection (when
 * `options.model` is omitted):
 * - Transparent / PNG / icon / sticker → `gpt-image-1.5` (ONLY model with transparency)
 * - Brand / UI / text / logo prompts   → `gpt-image-2`
 * - "Quick" / "draft" prompts          → `flux-2-klein-9b` (free tier)
 * - Otherwise                          → `gpt-image-2` (on-brand default)
 *
 * `edit(prompt, images, editOptions?)` — IDENTITY-PRESERVING EDIT. Pass the
 * user's uploaded photo(s) as base64 / data-URL string(s); the model KEEPS the
 * exact subject (the car, the kitchen, the person) and only changes what the
 * prompt asks. Use this for wrap/room visualizers, virtual try-on, "restyle
 * this exact photo" flows. Do NOT use `generate` for those — it invents a
 * brand-new subject from the text alone.
 *
 * Usage:
 * ```tsx
 * function WrapVisualizer() {
 *   const { generate, edit, loading, image, error } = useAiImage();
 *
 *   // text-to-image
 *   const makeLogo = () => generate('Minimalist sleep-tracker app icon, soft blue gradient');
 *
 *   // identity-preserving edit — keeps the user's exact car
 *   const applyWrap = (photoDataUrl: string) =>
 *     edit('Apply a matte black vinyl wrap to this exact vehicle. Keep the car, angle, wheels and background identical.', photoDataUrl);
 *
 *   return image ? <img src={image.url || `data:image/png;base64,${image.image}`} alt="" /> : null;
 * }
 * ```
 */
export function useAiImage(options?: UseAiImageOptions) {
  const [image, setImage] = useState<GeneratedImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authHeaders = (): Record<string, string> => {
    const token = getAuthToken();
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  };

  const generate = useCallback(async (prompt: string): Promise<GeneratedImage | null> => {
    if (!prompt || !prompt.trim()) {
      setError('Prompt is required');
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        prompt: prompt.trim()
      };
      if (options?.model) body.model = options.model;
      if (options?.size) body.size = options.size;
      if (options?.quality) body.quality = options.quality;
      if (options?.transparent) body.transparent = options.transparent;
      if (options?.format) body.format = options.format;
      if (options?.aspectRatio) body.aspectRatio = options.aspectRatio;
      if (options?.style) body.style = options.style;

      const response = await fetch('/api/ai/image', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body)
      });

      const { ok, data, friendlyError } = await parseImageResponse(response);
      if (!ok) {
        throw new Error(
          friendlyError ||
            (data.error as string) ||
            (data.hint as string) ||
            `Image generation failed (${response.status})`
        );
      }

      const result = toGeneratedImage(data);
      setImage(result);
      options?.onSuccess?.(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      options?.onError?.(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [options]);

  const edit = useCallback(
    async (
      prompt: string,
      images: string | string[],
      editOptions?: EditImageOptions
    ): Promise<GeneratedImage | null> => {
      if (!prompt || !prompt.trim()) {
        setError('Prompt is required');
        return null;
      }
      const imageList = (Array.isArray(images) ? images : [images]).filter(Boolean);
      if (imageList.length === 0) {
        setError('At least one reference image is required to edit');
        return null;
      }

      setLoading(true);
      setError(null);

      try {
        const body: Record<string, unknown> = {
          prompt: prompt.trim(),
          images: imageList,
          // input_fidelity defaults to 'high' server-side, but be explicit so
          // the intent (keep the exact subject) is obvious in the request.
          input_fidelity: editOptions?.inputFidelity ?? 'high'
        };
        if (editOptions?.mask) body.mask = editOptions.mask;
        if (editOptions?.model ?? options?.model) body.model = editOptions?.model ?? options?.model;
        if (editOptions?.size ?? options?.size) body.size = editOptions?.size ?? options?.size;
        if (editOptions?.format ?? options?.format) body.format = editOptions?.format ?? options?.format;
        if (editOptions?.transparent ?? options?.transparent) body.transparent = editOptions?.transparent ?? options?.transparent;
        if (options?.quality) body.quality = options.quality;

        const response = await fetch('/api/ai/image/edit', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(body)
        });

        const { ok, data, friendlyError } = await parseImageResponse(response);
        if (!ok) {
          throw new Error(
            friendlyError ||
              (data.error as string) ||
              (data.hint as string) ||
              `Image edit failed (${response.status})`
          );
        }

        const result = toGeneratedImage(data);
        setImage(result);
        options?.onSuccess?.(result);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        options?.onError?.(message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [options]
  );

  const reset = useCallback(() => {
    setImage(null);
    setError(null);
  }, []);

  return {
    generate,
    edit,
    image,
    loading,
    error,
    reset
  };
}

export default useAiImage;
