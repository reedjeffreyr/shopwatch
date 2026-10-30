import { getAuthToken } from '@/lib/auth';
import { useState, useCallback } from 'react';

// useAiObject — generate a structured JSON object from a prompt.
// Companion to useAiChat: when you don't want a chat reply, you want a
// typed value (a tagged email, a list of extracted line-items, a parsed
// receipt, etc.), use this instead.
//
// Inspired by Vercel AI SDK's `generateObject`:
// https://sdk.vercel.ai/docs/ai-sdk-core/generating-structured-data
//
// Wire format: POST /api/ai/object on this app's Worker.
//   { prompt, schema, schemaName?, system?, model?, temperature?, max_tokens? }
// Returns: { success, object, model, usage, elapsed_ms }
//
// Provider routing happens server-side based on env.AI_CHAT_MODEL or the
// model the caller passes. All three providers we route to support
// JSON-schema-constrained output:
//   - Gemini: generationConfig.responseSchema + responseMimeType
//   - OpenAI: response_format: { type: "json_schema", json_schema: ... }
//   - Claude: tool-forcing pattern (synthetic tool with the schema)
//
// Workers AI is NOT supported here — small open models can't be relied on
// to honor a JSON schema strictly. The server returns a 400 directing the
// caller to upgrade if their app is on the free tier.

// JSONSchema is intentionally typed loose — TS can't infer typed object
// shape from a runtime schema, and we don't want to ship a 200kb runtime
// just to do that. Callers who want type safety should pass a generic:
//   const { object } = useAiObject<{ category: string; sentiment: number }>(...)
export type JSONSchema =
  | { type: 'object'; properties?: Record<string, JSONSchema>; required?: string[]; additionalProperties?: boolean }
  | { type: 'array'; items?: JSONSchema; minItems?: number; maxItems?: number }
  | { type: 'string'; enum?: string[]; description?: string }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: string; [key: string]: unknown }; // escape hatch for less-common types

export interface UseAiObjectOptions {
  /** Provider model. Defaults to the app's AI_CHAT_MODEL. */
  model?: string;
  /** Optional system instruction prepended to the prompt. */
  system?: string;
  /** Sampling temperature. Default: 0.2 (low — structured output should be deterministic). */
  temperature?: number;
  /** Max output tokens. Default: 8192 (raised from 2048 — #1625: 2048 silently
   *  truncated multi-item / large structured outputs). Lower it to cap cost. */
  maxTokens?: number;
  /** Optional callback fired on successful generation. */
  onObject?: <T>(object: T) => void;
  /** Optional callback fired on failure. */
  onError?: (error: string) => void;
}

export interface UseAiObjectResult<T> {
  /** The most recently generated object, or null if nothing generated yet. */
  object: T | null;
  /** True while a request is in flight. */
  loading: boolean;
  /** Most recent error message, or null. */
  error: string | null;
  /** Generate. Resolves to the parsed object, or null on failure. */
  generate: (prompt: string) => Promise<T | null>;
  /** Reset the most recent object/error to their initial state. */
  reset: () => void;
}

/**
 * Generate a structured, schema-constrained JSON object from a natural-language prompt.
 *
 * Use this when you want the AI to extract or synthesize TYPED data (not free-form text).
 * Common use cases:
 *   - Tag an email: { category, priority, sentiment }
 *   - Parse a receipt: { vendor, total, line_items[] }
 *   - Extract from form text: { name, email, phone, intent }
 *   - Triage a support ticket: { topic, urgency, suggested_reply }
 *
 * Example:
 * ```tsx
 * type Triage = {
 *   category: 'bug' | 'feature' | 'question';
 *   urgency: 'low' | 'medium' | 'high';
 *   summary: string;
 * };
 *
 * const triageSchema = {
 *   type: 'object',
 *   properties: {
 *     category: { type: 'string', enum: ['bug', 'feature', 'question'] },
 *     urgency:  { type: 'string', enum: ['low', 'medium', 'high'] },
 *     summary:  { type: 'string', description: 'One-sentence summary' },
 *   },
 *   required: ['category', 'urgency', 'summary'],
 * } as const;
 *
 * function Triage() {
 *   const { object, generate, loading, error } = useAiObject<Triage>(triageSchema, {
 *     system: 'You triage incoming customer support messages.',
 *   });
 *
 *   return (
 *     <div>
 *       <textarea onBlur={(e) => generate(e.target.value)} />
 *       {loading && <p>Triaging…</p>}
 *       {error && <p>{error}</p>}
 *       {object && (
 *         <ul>
 *           <li>Category: {object.category}</li>
 *           <li>Urgency: {object.urgency}</li>
 *           <li>Summary: {object.summary}</li>
 *         </ul>
 *       )}
 *     </div>
 *   );
 * }
 * ```
 *
 * Notes:
 * - The schema is sent server-side and enforced by the underlying model. If the
 *   model can't produce valid JSON matching the schema, the hook returns null
 *   and surfaces an error. This is rare with current Gemini/Claude/GPT models
 *   when the schema is reasonable.
 * - Like useAiChat, this consumes credits per request. Cost scales with input
 *   prompt length + schema complexity + max_tokens.
 * - For long-running multi-turn AI conversations, use useAiChat. For "extract
 *   structured data from one input", use this.
 */
export function useAiObject<T = unknown>(
  schema: JSONSchema,
  options?: UseAiObjectOptions
): UseAiObjectResult<T> {
  const [object, setObject] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(
    async (prompt: string): Promise<T | null> => {
      if (!prompt || !prompt.trim()) {
        setError('prompt is required');
        return null;
      }

      setLoading(true);
      setError(null);

      try {
        const token = getAuthToken();

        const response = await fetch('/api/ai/object', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && { Authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify({
            prompt: prompt.trim(),
            schema,
            system: options?.system,
            model: options?.model,
            temperature: options?.temperature ?? 0.2,
            // #1625: default 8192 (was 2048). Multi-item / rich-object schemas
            // routinely exceed 2048 output tokens; the old default silently
            // truncated them, surfacing as an opaque parse/"invalid JSON" error.
            max_tokens: options?.maxTokens ?? 8192,
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'AI request failed' }));
          throw new Error(err.error || 'AI request failed');
        }

        const data = await response.json();
        const parsed = data.object as T;
        setObject(parsed);
        options?.onObject?.(parsed);
        return parsed;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        options?.onError?.(message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [schema, options]
  );

  const reset = useCallback(() => {
    setObject(null);
    setError(null);
  }, []);

  return { object, loading, error, generate, reset };
}

export default useAiObject;
