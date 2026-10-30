import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useSpeech — FREE on-device text-to-speech via the browser's Web Speech API
 * (`window.speechSynthesis` / `SpeechSynthesisUtterance`).
 *
 * ⚠️ USE THIS BY DEFAULT for LONG-FORM read-aloud / narration / "listen to
 * this article/summary/page" / any text the USER supplies or that is more
 * than ~1,000 characters. It is 100% FREE — zero network, zero OverSkill
 * credits, no platform dependency. The audio is synthesized locally by the
 * user's own device/OS voices.
 *
 * Contrast with `useAiAudio()` (the PAID `/api/ai/audio/*` ElevenLabs path),
 * which bills ~0.5–1 credit PER CHARACTER. Narrating a full page/summary with
 * ElevenLabs can cost thousands of credits (a whole credit pack) in a single
 * tap — DON'T do that for long-form read-aloud. Reserve `useAiAudio()` for:
 *   - short fixed cues / notifications
 *   - generated SOUND EFFECTS / MUSIC (no browser equivalent)
 *   - an explicit user-opt-in "HD / studio voice" upgrade where the credit
 *     cost is shown up front before generating.
 *
 * The typical hybrid pattern is: free `useSpeech()` by default, plus an
 * optional "HD Voice" toggle that routes to `useAiAudio().generateTts(...)`.
 *
 * ─── Gotchas this hook handles for you (all non-negotiable) ─────────────────
 *
 *  • Async voice loading + QUALITY-RANKED default — voices populate lazily; the
 *    underlying `getVoices()` often returns `[]` on first call. We subscribe to
 *    `speechSynthesis.onvoiceschanged` and expose the resolved `voices` list
 *    plus the BEST-quality default voice for the utterance language. We do NOT
 *    blanket-prefer `localService` — on macOS the local voices are the ROBOTIC
 *    "compact" defaults (Alex/Fred/bare-name Samantha), which is exactly why
 *    browser TTS "sounds bad on Mac". Instead we rank: enhanced (Siri /
 *    "(Enhanced)" / "(Premium)" / neural / "Natural") > network (Chrome's
 *    "Google …") > standard > compact. The hook also exposes `voiceQuality`
 *    ('enhanced'|'network'|'standard'|'compact') and, when a Mac user has only
 *    low-quality voices installed, `showEnhancedVoiceTip:true` + a ready-to-
 *    render `enhancedVoiceTip` so the app can nudge the user to download an
 *    Enhanced voice (the hook never renders UI itself).
 *
 *  • Long-text chunking — many engines choke or silently truncate very long
 *    utterances (some cap ~32k chars), and Chrome has a long-standing bug
 *    where a single long utterance stops speaking after ~15 seconds. We split
 *    the text into sentence-ish chunks (~200–500 chars, broken on sentence
 *    boundaries) and speak them sequentially so a full book summary narrates
 *    end-to-end. A periodic `pause()/resume()` keepalive further mitigates the
 *    Chrome 15s cutoff.
 *
 *  • iOS / Safari user-gesture requirement — the FIRST `speak()` must be
 *    triggered from a user gesture (a click/tap). Call `speak()` directly from
 *    your Play button's `onClick` — do NOT kick it off from an effect / timer
 *    / async callback, or iOS Safari will silently refuse to speak.
 *
 *  • Graceful fallback — if `window.speechSynthesis` is unavailable, the hook
 *    NEVER throws; it returns `supported: false` so the UI can hide the free
 *    option and fall back to the paid HD path.
 *
 * ─── Usage ──────────────────────────────────────────────────────────────────
 * ```tsx
 * function ListenButton({ summary }: { summary: string }) {
 *   const { supported, speaking, paused, speak, pause, resume, stop } = useSpeech();
 *   if (!supported) return null; // fall back to an HD-voice (useAiAudio) button
 *   return (
 *     <div>
 *       {!speaking && <button onClick={() => speak(summary)}>▶︎ Listen</button>}
 *       {speaking && !paused && <button onClick={pause}>⏸ Pause</button>}
 *       {speaking && paused && <button onClick={resume}>▶︎ Resume</button>}
 *       {speaking && <button onClick={stop}>⏹ Stop</button>}
 *     </div>
 *   );
 * }
 * ```
 *
 * Read-along highlighting — the `boundary` word-boundary event exposes the
 * current char index of the whole text via `charIndex`:
 * ```tsx
 * const { speak, charIndex } = useSpeech();
 * // highlight text.slice(0, charIndex) as it's spoken
 * ```
 */

export interface SpeakOptions {
  /** Speaking rate 0.1–10, default 1. */
  rate?: number;
  /** Pitch 0–2, default 1. */
  pitch?: number;
  /** Volume 0–1, default 1. */
  volume?: number;
  /** BCP-47 language tag, e.g. 'en-US'. Defaults to the picked voice's lang. */
  lang?: string;
  /**
   * Specific voice to use. Pass a `SpeechSynthesisVoice` (from `voices`) or a
   * voice name/voiceURI string. Omit to use the auto-picked default voice.
   */
  voice?: SpeechSynthesisVoice | string;
  /** Called once when the very first chunk starts speaking. */
  onStart?: () => void;
  /** Called once when all chunks finish (natural end). */
  onEnd?: () => void;
  /** Called on a synthesis error. NEVER throws. */
  onError?: (message: string) => void;
}

export interface UseSpeechOptions {
  /**
   * Max characters per chunk (default 300). Text is split on sentence
   * boundaries as close to this size as possible. Keep in the ~200–500 range —
   * small enough to dodge the Chrome ~15s cutoff, large enough to sound
   * natural.
   */
  maxChunkChars?: number;
  /** Default speaking rate for `speak()` calls that omit one. */
  defaultRate?: number;
  /** Default pitch for `speak()` calls that omit one. */
  defaultPitch?: number;
  /**
   * Enable the Chrome pause()/resume() keepalive that works around the
   * long-utterance ~15s cutoff. Default true. Harmless on other browsers.
   */
  chromeKeepalive?: boolean;
}

export interface UseSpeechResult {
  /** False when `window.speechSynthesis` is unavailable — hide the free UI. */
  supported: boolean;
  /** Resolved list of on-device voices (populates asynchronously). */
  voices: SpeechSynthesisVoice[];
  /**
   * The voice the hook will use by default — the BEST-quality voice available
   * for the browser/OS language (see `pickDefaultVoice`). NOT necessarily a
   * local voice: on macOS a Siri/"(Enhanced)" voice or a Chrome network voice
   * is preferred over the robotic compact defaults.
   */
  defaultVoice: SpeechSynthesisVoice | null;
  /**
   * Quality bucket of `defaultVoice` ('enhanced' | 'network' | 'standard' |
   * 'compact'), or null before voices load. Use it to show a "voice quality"
   * hint or to decide whether to surface the Enhanced-voices tip.
   */
  voiceQuality: VoiceQuality | null;
  /**
   * True ONLY on macOS AND when the best available voice is merely
   * 'compact'/'standard' (no Enhanced/Siri/network voice installed). The
   * consumer should render a subtle, one-time, dismissible tip pointing the
   * user at System Settings to download an Enhanced voice — see
   * `enhancedVoiceTip` for the copy. The hook does NOT render UI (it's a hook);
   * dismiss-persistence is the consumer's job.
   */
  showEnhancedVoiceTip: boolean;
  /** Ready-to-render copy for the Enhanced-voices tip (see `ENHANCED_VOICE_TIP`). */
  enhancedVoiceTip: string;
  /** True while any chunk is being spoken (incl. while paused). */
  speaking: boolean;
  /** True while speech is paused. */
  paused: boolean;
  /**
   * Char index into the ORIGINAL text of the word currently being spoken
   * (from the `boundary` event) — use it for read-along highlighting. 0 when
   * idle.
   */
  charIndex: number;
  /**
   * Start narrating `text`. MUST be called from a user gesture on the first
   * play (iOS/Safari requirement). Cancels any in-progress narration first.
   */
  speak: (text: string, options?: SpeakOptions) => void;
  /** Pause the current narration (resumable). */
  pause: () => void;
  /** Resume a paused narration. */
  resume: () => void;
  /** Stop and clear the queue. Safe to call anytime. */
  stop: () => void;
}

/**
 * Split `text` into sentence-ish chunks no larger than `maxChars`. Breaks on
 * sentence-ending punctuation first, then on whitespace, then hard-splits an
 * over-long token as a last resort. Never returns empty chunks.
 */
export function chunkText(text: string, maxChars = 300): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  // Split into sentences (keep the terminating punctuation).
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [clean];
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = '';
  };

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > maxChars) {
      // A single sentence longer than the cap — flush what we have, then
      // break the long sentence on word boundaries.
      pushCurrent();
      let word = '';
      for (const token of sentence.split(/\s+/)) {
        if (token.length > maxChars) {
          // Pathological token (e.g. a giant URL) — hard-split it.
          if (word.trim()) {
            chunks.push(word.trim());
            word = '';
          }
          for (let i = 0; i < token.length; i += maxChars) {
            chunks.push(token.slice(i, i + maxChars));
          }
          continue;
        }
        if ((word + ' ' + token).trim().length > maxChars) {
          if (word.trim()) chunks.push(word.trim());
          word = token;
        } else {
          word = word ? `${word} ${token}` : token;
        }
      }
      if (word.trim()) chunks.push(word.trim());
      continue;
    }

    if ((current + ' ' + sentence).trim().length > maxChars) {
      pushCurrent();
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  pushCurrent();

  return chunks.filter((c) => c.length > 0);
}

/**
 * A coarse quality bucket for a synthesized voice, best → worst:
 *
 *  • 'enhanced' — a genuinely high-quality neural/premium voice. On macOS these
 *    are the "(Enhanced)" / "(Premium)" downloads and the Siri voices; on
 *    Windows Edge these are the free Azure "Natural" / neural voices. This is
 *    what you WANT for narration.
 *  • 'network'  — a non-local (network) voice, e.g. Chrome's "Google US English".
 *    These are usually noticeably better than the OS compact defaults.
 *  • 'compact'  — the low-quality, robotic on-device defaults macOS ships with
 *    and selects by DEFAULT (Alex, Fred, and the bare-name "Samantha"/"Victoria"
 *    compact variants). This is the thing that makes browser TTS "sound bad on
 *    Mac". We AVOID these unless nothing better exists.
 *  • 'standard' — any other named local voice that isn't obviously one of the
 *    known-bad compact defaults. Acceptable, but we still prefer enhanced/network.
 */
export type VoiceQuality = 'enhanced' | 'network' | 'standard' | 'compact';

// High-quality voice NAME patterns. macOS: "(Enhanced)", "(Premium)", Siri.
// Windows/Edge: free Azure "Natural" / neural voices. Chrome sometimes labels
// its better voices "Natural" too.
const ENHANCED_NAME = /(\bsiri\b|\(enhanced\)|\(premium\)|neural|natural)/i;

// Known-BAD macOS compact/robotic defaults — the ones the browser picks by
// default and that Todd (correctly) calls "so bad". Bare-name (no "(Enhanced)")
// Samantha/Victoria/etc. are the compact builds; Alex/Fred/Albert/etc. are the
// classic robotic voices. These are demoted to last resort.
const COMPACT_NAME =
  /^(alex|fred|albert|bad news|bahh|bells|boing|bruce|bubbles|cellos|deranged|good news|hysterical|junior|kathy|pipe organ|princess|ralph|trinoids|whisper|zarvox|agnes|vicki)\b/i;
const BARE_COMPACT_NAME =
  /^(samantha|victoria|daniel|karen|moira|tessa|fiona|veena|rishi|serena|tom|allison|ava|nathan|susan)$/i;

/**
 * Classify a single voice into a quality bucket. Uses the voice NAME (the only
 * reliable cross-browser signal for "enhanced/neural") plus `localService`
 * (a network voice usually beats an OS compact voice) to decide.
 */
export function classifyVoiceQuality(voice: SpeechSynthesisVoice): VoiceQuality {
  const name = voice?.name || '';
  if (ENHANCED_NAME.test(name)) return 'enhanced';
  // A network voice (localService === false) is generally better than a local
  // compact default — Chrome's "Google …" voices are the common example.
  if (voice && voice.localService === false) return 'network';
  if (COMPACT_NAME.test(name) || BARE_COMPACT_NAME.test(name)) return 'compact';
  return 'standard';
}

const QUALITY_RANK: Record<VoiceQuality, number> = {
  enhanced: 3,
  network: 2,
  standard: 1,
  compact: 0,
};

/**
 * Pick the BEST-quality default voice for the given language.
 *
 * ⚠️ This deliberately does NOT blanket-prefer `localService` — on macOS the
 * local voices are the ROBOTIC compact defaults, so preferring them is exactly
 * why browser TTS "sounds bad on Mac". Instead we QUALITY-RANK candidates:
 *   1. enhanced (Siri / "(Enhanced)" / "(Premium)" / neural / natural)
 *   2. network  (non-local voices, e.g. Chrome's "Google …")
 *   3. standard (other named modern local voices)
 *   4. compact  (Alex/Fred/bare-name Samantha — last resort)
 *
 * We first restrict to voices matching the utterance language (exact tag, then
 * base-language prefix), rank WITHIN that set, and only if the language has no
 * voices at all do we fall back to the globally-best voice.
 */
export function pickDefaultVoice(
  voices: SpeechSynthesisVoice[],
  lang?: string
): SpeechSynthesisVoice | null {
  if (!voices || voices.length === 0) return null;
  const target = (lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US') || 'en-US').toLowerCase();
  const base = target.split('-')[0];

  // Best of a candidate set: highest quality bucket wins; ties broken by
  // preferring an exact language-tag match, then the voice flagged `default`,
  // then original discovery order (stable).
  const bestOf = (candidates: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null => {
    if (candidates.length === 0) return null;
    let best = candidates[0];
    let bestScore = -1;
    for (const v of candidates) {
      const vLang = (v.lang || '').toLowerCase();
      const score =
        QUALITY_RANK[classifyVoiceQuality(v)] * 10 +
        (vLang === target ? 2 : 0) +
        (v.default ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  };

  // Prefer voices in the requested base language (covers en-US, en-GB, …).
  const inLang = voices.filter((v) => (v.lang || '').toLowerCase().startsWith(base));
  const inLangBest = bestOf(inLang);
  if (inLangBest) return inLangBest;

  // No voice for this language at all → return the globally best voice so the
  // user still hears SOMETHING (never null when voices exist).
  return bestOf(voices);
}

/**
 * The quality bucket of the voice `pickDefaultVoice` would choose for `lang`.
 * Consumers use this to (a) show a "voice quality" hint and (b) decide whether
 * to surface the "enable Enhanced voices" tip (see `shouldShowEnhancedVoiceTip`).
 */
export function defaultVoiceQuality(
  voices: SpeechSynthesisVoice[],
  lang?: string
): VoiceQuality | null {
  const v = pickDefaultVoice(voices, lang);
  return v ? classifyVoiceQuality(v) : null;
}

/** True when the current platform is macOS (used to gate the Enhanced-voices tip). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const plat = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
  // Match "Mac" but NOT iOS (iPhone/iPad) — iOS voice management is different
  // and the "System Settings → Accessibility" instructions don't apply there.
  return /mac/i.test(plat) && !/(iphone|ipad|ipod)/i.test(plat);
}

/**
 * The subtle, one-time tip to render when a Mac user has only low-quality
 * voices installed. Exposed as a constant so the APP/template renders the UI —
 * the hook never renders (it's a hook). Persistence of "dismissed" is the
 * consumer's responsibility.
 */
export const ENHANCED_VOICE_TIP =
  'For much better narration, enable Enhanced voices: System Settings → ' +
  'Accessibility → Spoken Content → System Voice → download an Enhanced or ' +
  'Premium voice (e.g. "Samantha (Enhanced)").';

/**
 * Should the consumer surface the "enable Enhanced voices" tip?
 *
 * Only true when BOTH:
 *  (a) we're on macOS, AND
 *  (b) the best voice we could pick is only 'compact' or 'standard' quality
 *      (i.e. NO enhanced/Siri/premium AND no network voice is available).
 *
 * This gates the nudge so we don't nag users who already have good voices.
 */
export function shouldShowEnhancedVoiceTip(
  voices: SpeechSynthesisVoice[],
  lang?: string,
  isMac: boolean = isMacPlatform()
): boolean {
  if (!isMac) return false;
  if (!voices || voices.length === 0) return false;
  const q = defaultVoiceQuality(voices, lang);
  return q === 'compact' || q === 'standard';
}

function resolveVoice(
  wanted: SpeechSynthesisVoice | string | undefined,
  voices: SpeechSynthesisVoice[],
  fallback: SpeechSynthesisVoice | null
): SpeechSynthesisVoice | null {
  if (!wanted) return fallback;
  if (typeof wanted !== 'string') return wanted;
  const byURI = voices.find((v) => v.voiceURI === wanted);
  if (byURI) return byURI;
  const byName = voices.find((v) => v.name === wanted);
  return byName || fallback;
}

// ─── Framework-agnostic engine ──────────────────────────────────────────────
// All the imperative narration logic (chunking, sequential queueing, keepalive,
// pause/resume/stop) lives here so it can be unit-tested WITHOUT a React
// renderer. `useSpeech()` is a thin React wrapper over this. The engine takes
// its `speechSynthesis`, `SpeechSynthesisUtterance`, and timer functions by
// injection so tests can supply fakes.

export interface SpeechEngineDeps {
  synth: SpeechSynthesis;
  Utterance: typeof SpeechSynthesisUtterance;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
  navigatorLang?: string;
}

export interface SpeechEngineConfig {
  maxChunkChars: number;
  defaultRate: number;
  defaultPitch: number;
  chromeKeepalive: boolean;
  /** Emits state changes so a consumer (the hook) can re-render. */
  onState?: (state: { speaking: boolean; paused: boolean; charIndex: number }) => void;
  getVoices: () => SpeechSynthesisVoice[];
  getDefaultVoice: () => SpeechSynthesisVoice | null;
}

export interface SpeechEngine {
  speak: (text: string, options?: SpeakOptions) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

export function createSpeechEngine(
  deps: SpeechEngineDeps,
  config: SpeechEngineConfig
): SpeechEngine {
  const { synth, Utterance } = deps;
  const setIntervalFn = deps.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearInterval || ((id) => clearInterval(id));
  const navLang =
    deps.navigatorLang ||
    (typeof navigator !== 'undefined' ? navigator.language : 'en-US') ||
    'en-US';

  let chunks: string[] = [];
  let offsets: number[] = [];
  let index = 0;
  let opts: SpeakOptions = {};
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  const emit = (speaking: boolean, paused: boolean, charIndex: number) =>
    config.onState?.({ speaking, paused, charIndex });

  const clearKeepalive = () => {
    if (keepalive != null) {
      clearIntervalFn(keepalive);
      keepalive = null;
    }
  };

  const stop = () => {
    cancelled = true;
    clearKeepalive();
    chunks = [];
    offsets = [];
    index = 0;
    try {
      synth.cancel();
    } catch {
      /* never throw */
    }
    emit(false, false, 0);
  };

  const speakChunk = () => {
    if (cancelled || index >= chunks.length) {
      clearKeepalive();
      if (!cancelled && index >= chunks.length && chunks.length > 0) {
        emit(false, false, 0);
        opts.onEnd?.();
      }
      return;
    }

    const utter = new Utterance(chunks[index]);
    utter.rate = opts.rate ?? config.defaultRate;
    utter.pitch = opts.pitch ?? config.defaultPitch;
    utter.volume = opts.volume ?? 1;

    const voice = resolveVoice(opts.voice, config.getVoices(), config.getDefaultVoice());
    if (voice) utter.voice = voice;
    utter.lang = opts.lang || voice?.lang || navLang;

    const chunkStart = offsets[index] ?? 0;

    utter.onboundary = (ev: SpeechSynthesisEvent) => {
      if (typeof ev.charIndex === 'number') emit(true, false, chunkStart + ev.charIndex);
    };
    utter.onend = () => {
      if (cancelled) return;
      index += 1;
      speakChunk();
    };
    utter.onerror = (ev: SpeechSynthesisErrorEvent) => {
      const err = ev.error;
      if (err && err !== 'interrupted' && err !== 'canceled') {
        clearKeepalive();
        emit(false, false, 0);
        opts.onError?.(String(err));
      }
    };

    if (index === 0) opts.onStart?.();

    try {
      synth.speak(utter);
    } catch (e) {
      clearKeepalive();
      emit(false, false, 0);
      opts.onError?.(e instanceof Error ? e.message : 'speech synthesis failed');
    }
  };

  const speak = (text: string, spokenOptions: SpeakOptions = {}) => {
    const parts = chunkText(text, config.maxChunkChars);
    if (parts.length === 0) return;

    cancelled = false;
    clearKeepalive();
    try {
      synth.cancel();
    } catch {
      /* ignore */
    }

    const collapsed = (text || '').replace(/\s+/g, ' ').trim();
    const nextOffsets: number[] = [];
    let running = 0;
    for (const c of parts) {
      const at = collapsed.indexOf(c, running);
      const pos = at >= 0 ? at : running;
      nextOffsets.push(pos);
      running = pos + c.length;
    }

    chunks = parts;
    offsets = nextOffsets;
    index = 0;
    opts = spokenOptions;

    emit(true, false, 0);

    if (config.chromeKeepalive) {
      keepalive = setIntervalFn(() => {
        if (cancelled) return;
        try {
          if (synth.speaking && !synth.paused) {
            synth.pause();
            synth.resume();
          }
        } catch {
          /* ignore */
        }
      }, 10000);
    }

    speakChunk();
  };

  const pause = () => {
    try {
      synth.pause();
      emit(true, true, -1);
    } catch {
      /* ignore */
    }
  };

  const resume = () => {
    try {
      synth.resume();
      emit(true, false, -1);
    } catch {
      /* ignore */
    }
  };

  return { speak, pause, resume, stop };
}

export function useSpeech(options: UseSpeechOptions = {}): UseSpeechResult {
  const {
    maxChunkChars = 300,
    defaultRate = 1,
    defaultPitch = 1,
    chromeKeepalive = true,
  } = options;

  const supported =
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined';

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [defaultVoice, setDefaultVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [voiceQuality, setVoiceQuality] = useState<VoiceQuality | null>(null);
  const [showEnhancedVoiceTip, setShowEnhancedVoiceTip] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [charIndex, setCharIndex] = useState(0);

  // Latest voice/default readable from the engine's callbacks without
  // re-creating the engine on every voice update.
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  const defaultVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  voicesRef.current = voices;
  defaultVoiceRef.current = defaultVoice;

  const engineRef = useRef<SpeechEngine | null>(null);

  // ── Async voice loading ──────────────────────────────────────────────────
  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;

    const load = () => {
      const list = synth.getVoices();
      if (list && list.length) {
        setVoices(list);
        // Re-run the quality ranking every time voices populate/change (they
        // arrive lazily via onvoiceschanged, and enhanced voices sometimes
        // register a beat AFTER the compact defaults). We recompute the best
        // voice + its quality + the tip signal so the UI upgrades in place.
        const best = pickDefaultVoice(list);
        setDefaultVoice((prev) => prev || best);
        setVoiceQuality(best ? classifyVoiceQuality(best) : null);
        setShowEnhancedVoiceTip(shouldShowEnhancedVoiceTip(list));
      }
    };

    load(); // some browsers have them ready synchronously
    synth.addEventListener?.('voiceschanged', load);
    // Fallback for browsers that only expose the on* property.
    const prevHandler = synth.onvoiceschanged;
    synth.onvoiceschanged = load;

    return () => {
      synth.removeEventListener?.('voiceschanged', load);
      synth.onvoiceschanged = prevHandler || null;
    };
  }, [supported]);

  // One engine per mount, wired to React state via onState.
  useEffect(() => {
    if (!supported) {
      engineRef.current = null;
      return;
    }
    engineRef.current = createSpeechEngine(
      {
        synth: window.speechSynthesis,
        Utterance: window.SpeechSynthesisUtterance,
      },
      {
        maxChunkChars,
        defaultRate,
        defaultPitch,
        chromeKeepalive,
        getVoices: () => voicesRef.current,
        getDefaultVoice: () => defaultVoiceRef.current,
        onState: ({ speaking: s, paused: p, charIndex: ci }) => {
          setSpeaking(s);
          setPaused(p);
          // charIndex === -1 is the engine's "leave charIndex unchanged" signal
          // (emitted by pause/resume). Only update on a real index.
          if (ci >= 0) setCharIndex(ci);
        },
      }
    );
    const engine = engineRef.current;
    // Cancel any in-flight speech on unmount so navigating away stops audio.
    return () => {
      engine?.stop();
      engineRef.current = null;
    };
  }, [supported, maxChunkChars, defaultRate, defaultPitch, chromeKeepalive]);

  const speak = useCallback(
    (text: string, spokenOptions: SpeakOptions = {}) => {
      if (!supported || !engineRef.current) {
        // NEVER throw — callers should gate on `supported`.
        spokenOptions.onError?.('speechSynthesis is not supported in this browser');
        return;
      }
      engineRef.current.speak(text, spokenOptions);
    },
    [supported]
  );

  const pause = useCallback(() => engineRef.current?.pause(), []);
  const resume = useCallback(() => engineRef.current?.resume(), []);
  const stop = useCallback(() => engineRef.current?.stop(), []);

  return {
    supported,
    voices,
    defaultVoice,
    voiceQuality,
    showEnhancedVoiceTip,
    enhancedVoiceTip: ENHANCED_VOICE_TIP,
    speaking,
    paused,
    charIndex,
    speak,
    pause,
    resume,
    stop,
  };
}

export default useSpeech;
