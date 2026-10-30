import { getAuthToken } from '@/lib/auth';
import { useState, useCallback } from 'react';

export type AiTtsModel =
  | 'eleven_multilingual_v2'  // Best quality (default) — $0.10/1K chars
  | 'eleven_flash_v2_5'       // Fastest, half the cost — $0.05/1K chars
  | 'eleven_v3';              // Premium quality

/** Curated platform voice IDs. Exposed via /api/ai/audio/voices at runtime. */
export type AiVoiceId =
  | '21m00Tcm4TlvDq8ikWAM'  // Rachel — warm female narrator (default)
  | 'EXAVITQu4vr4xnSDxMaL'  // Sarah — clear, professional female
  | 'pNInz6obpgDQGcFmaJgB'  // Adam — deep male narrator
  | 'IKne3meq5aSn9XLyUdCD'; // Charlie — casual, friendly male

export interface UseAiNeuralTtsOptions {
  /** Language hint (e.g. 'en', 'es', 'fr'). Default 'en'. */
  lang?: string;
  onSuccess?: (result: GeneratedAudio) => void;
  onError?: (error: string) => void;
}

export interface UseAiTtsOptions {
  /** Voice ID. Omit to use Rachel (warm female narrator). */
  voiceId?: AiVoiceId | string;
  /** Model. Default 'eleven_multilingual_v2'. */
  modelId?: AiTtsModel;
  /** ElevenLabs voice settings passthrough. */
  voiceSettings?: { stability?: number; similarity_boost?: number };
  onSuccess?: (result: GeneratedAudio) => void;
  onError?: (error: string) => void;
}

export interface UseAiSoundOptions {
  /** Duration in seconds (0.5-22). Omit for auto-determined length. */
  durationSeconds?: number;
  /** 0.0-1.0, default 0.3 — how strictly the model follows the prompt. */
  promptInfluence?: number;
  onSuccess?: (result: GeneratedAudio) => void;
  onError?: (error: string) => void;
}

export interface UseAiMusicOptions {
  /** Length in milliseconds (1000-300000). Default 60000 (1 minute). */
  musicLengthMs?: number;
  onSuccess?: (result: GeneratedAudio) => void;
  onError?: (error: string) => void;
}

export interface GeneratedAudio {
  /** Presigned URL — valid for 1h. Use directly as `<audio src=...>`. */
  url: string;
  /** Model the gateway actually used. */
  model: string;
  /** TTS only: which voice was used (may differ from requested if fallback). */
  voiceId?: string;
  /** Sound/music only: requested duration. */
  durationSeconds?: number | null;
  /** Music only: requested length in ms. */
  musicLengthMs?: number;
  /** Credits charged to the creator. 0 when served from cache. */
  costCredits: number;
  /** True if the audio was served from R2 cache (same prompt, recently). */
  cached: boolean;
  /** Surface message when proxy applied a substitution (e.g. unknown voice → default). */
  note?: string;
  elapsedMs: number;
}

/**
 * useAiAudio — PAID AI audio generation (text-to-speech, sound effects,
 * music). Routes through `/api/ai/audio/*` → OverSkill Platform Proxy →
 * ElevenLabs. Unified billing, R2 cache, presigned URLs — no API keys
 * in client code.
 *
 * 💡 CHOOSING BETWEEN THE THREE TTS PATHS (cheap → expensive):
 *   1. `useSpeech()`            — FREE on-device browser TTS (Web Speech API).
 *      Zero credits, but quality varies by device (poor on some Macs). Good as
 *      the offline / zero-cost fallback.
 *   2. `generateNeuralTts()` (this hook) — the DEFAULT "good" voice. Cheap
 *      cloud NEURAL TTS (MeloTTS via Cloudflare Workers AI). Sounds good on
 *      EVERY device, R2-cached so it's ~free after the first play, and ~198x
 *      cheaper than ElevenLabs for long text (an ~18k-char summary ≈ 2 credits,
 *      0 on a repeat). USE THIS for read-aloud / narration by default.
 *   3. `generateTts()`         — PREMIUM ElevenLabs HD. Bills ~0.5–1 credit
 *      PER CHARACTER. Reserve for an explicit user-opt-in "HD / studio voice"
 *      upgrade, short fixed cues, or SOUND EFFECTS / MUSIC (no equivalent
 *      elsewhere) — always show the credit cost up front.
 *
 * ⚠️ Do NOT use `generateTts` to narrate a long article/summary by default —
 * a single full-summary listen can cost thousands of credits (a whole credit
 * pack) in one tap. Use `useSpeech()` for that; offer `useAiAudio` only as an
 * opt-in HD upgrade.
 *
 * Returns four separate generator functions:
 *   - `generateNeuralTts(text)` → DEFAULT good neural voice (cheap, cached)
 *   - `generateTts(text)` → premium ElevenLabs HD spoken-text MP3
 *   - `generateSound(text)` → sound effect MP3 (up to 22 seconds)
 *   - `generateMusic(prompt)` → music track MP3 (up to 5 minutes)
 *
 * All three share the same `audio`, `loading`, `error`, and `reset`
 * state, so the typical pattern is one hook per surface.
 *
 * Usage:
 * ```tsx
 * function VoiceoverButton({ script }: { script: string }) {
 *   const { generateTts, loading, audio, error } = useAiAudio();
 *
 *   return (
 *     <>
 *       <button onClick={() => generateTts(script)} disabled={loading}>
 *         {loading ? 'Generating…' : 'Speak'}
 *       </button>
 *       {error && <p className="error">{error}</p>}
 *       {audio && <audio src={audio.url} controls autoPlay />}
 *     </>
 *   );
 * }
 * ```
 *
 * For sound effects:
 * ```tsx
 * const { generateSound, audio } = useAiAudio();
 * generateSound('achievement bell chime', { durationSeconds: 1.5 });
 * ```
 *
 * For music:
 * ```tsx
 * const { generateMusic, audio } = useAiAudio();
 * generateMusic('uplifting electronic background music', { musicLengthMs: 120000 });
 * ```
 */
export function useAiAudio() {
  const [audio, setAudio] = useState<GeneratedAudio | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callEndpoint = useCallback(
    async (
      endpoint: 'tts' | 'tts-neural' | 'sound' | 'music',
      body: Record<string, unknown>,
      onSuccess?: (r: GeneratedAudio) => void,
      onError?: (e: string) => void
    ): Promise<GeneratedAudio | null> => {
      setLoading(true);
      setError(null);

      try {
        const token = getAuthToken();
        const response = await fetch(`/api/ai/audio/${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { Authorization: `Bearer ${token}` })
          },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(
            err.error || err.hint || `Audio generation failed (${response.status})`
          );
        }

        const data = await response.json();
        const result: GeneratedAudio = {
          url: data.url,
          model: data.model,
          voiceId: data.voice_id,
          durationSeconds: data.duration_seconds ?? null,
          musicLengthMs: data.music_length_ms,
          costCredits: data.cost_credits ?? 0,
          cached: Boolean(data.cached),
          note: data.note,
          elapsedMs: data.elapsed_ms
        };

        setAudio(result);
        onSuccess?.(result);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        onError?.(message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const generateNeuralTts = useCallback(
    async (text: string, options?: UseAiNeuralTtsOptions): Promise<GeneratedAudio | null> => {
      if (!text || !text.trim()) {
        setError('text is required');
        options?.onError?.('text is required');
        return null;
      }
      const body: Record<string, unknown> = { text: text.trim() };
      if (options?.lang) body.lang = options.lang;
      return callEndpoint('tts-neural', body, options?.onSuccess, options?.onError);
    },
    [callEndpoint]
  );

  const generateTts = useCallback(
    async (text: string, options?: UseAiTtsOptions): Promise<GeneratedAudio | null> => {
      if (!text || !text.trim()) {
        setError('text is required');
        options?.onError?.('text is required');
        return null;
      }
      const body: Record<string, unknown> = { text: text.trim() };
      if (options?.voiceId) body.voice_id = options.voiceId;
      if (options?.modelId) body.model_id = options.modelId;
      if (options?.voiceSettings) body.voice_settings = options.voiceSettings;
      return callEndpoint('tts', body, options?.onSuccess, options?.onError);
    },
    [callEndpoint]
  );

  const generateSound = useCallback(
    async (text: string, options?: UseAiSoundOptions): Promise<GeneratedAudio | null> => {
      if (!text || !text.trim()) {
        setError('text is required');
        options?.onError?.('text is required');
        return null;
      }
      const body: Record<string, unknown> = { text: text.trim() };
      if (options?.durationSeconds !== undefined)
        body.duration_seconds = options.durationSeconds;
      if (options?.promptInfluence !== undefined)
        body.prompt_influence = options.promptInfluence;
      return callEndpoint('sound', body, options?.onSuccess, options?.onError);
    },
    [callEndpoint]
  );

  const generateMusic = useCallback(
    async (prompt: string, options?: UseAiMusicOptions): Promise<GeneratedAudio | null> => {
      if (!prompt || !prompt.trim()) {
        setError('prompt is required');
        options?.onError?.('prompt is required');
        return null;
      }
      const body: Record<string, unknown> = { prompt: prompt.trim() };
      if (options?.musicLengthMs !== undefined)
        body.music_length_ms = options.musicLengthMs;
      return callEndpoint('music', body, options?.onSuccess, options?.onError);
    },
    [callEndpoint]
  );

  const reset = useCallback(() => {
    setAudio(null);
    setError(null);
  }, []);

  return {
    generateNeuralTts,
    generateTts,
    generateSound,
    generateMusic,
    audio,
    loading,
    error,
    reset
  };
}

export default useAiAudio;
