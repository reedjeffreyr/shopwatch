import React from 'react';

/**
 * Theme Preview Handler
 * Listens for postMessage events from the OverSkill editor to preview themes in real-time
 *
 * IMPORTANT (Bug 2 fix, May 2026):
 *   Previously this file applied previewed colors as inline `style.setProperty`
 *   calls on `document.documentElement`. Inline styles only target one selector
 *   (`:root`), so the dark-mode `.dark { ... }` rules in the deployed stylesheet
 *   stayed in effect when the user toggled to dark mode — they'd see the OLD
 *   theme's dark colors instead of the previewed preset.
 *
 *   We now inject a single <style id="overskill-theme-preview"> element that
 *   contains BOTH `:root` and `.dark` blocks. Both modes preview correctly
 *   regardless of which one is currently active, and TOGGLE_DARK_MODE no longer
 *   needs to re-apply colors — it just toggles the class.
 */

interface ThemeColors {
  background?: string;
  foreground?: string;
  primary?: string;
  primary_foreground?: string;
  secondary?: string;
  secondary_foreground?: string;
  accent?: string;
  accent_foreground?: string;
  muted?: string;
  muted_foreground?: string;
  card?: string;
  card_foreground?: string;
  popover?: string;
  popover_foreground?: string;
  destructive?: string;
  destructive_foreground?: string;
  border?: string;
  input?: string;
  ring?: string;
  sidebar_background?: string;
  sidebar_foreground?: string;
  sidebar_primary?: string;
  sidebar_primary_foreground?: string;
  sidebar_accent?: string;
  sidebar_accent_foreground?: string;
  sidebar_border?: string;
  sidebar_ring?: string;
}

interface ThemeTypography {
  font_sans?: string;
  font_serif?: string;
  font_mono?: string;
}

interface ThemeEffects {
  radius?: number;
  shadow?: {
    color?: string;
    opacity?: number;
    blur?: number;
    spread?: number;
    offset_x?: number;
    offset_y?: number;
  };
}

interface ThemeConfig {
  name?: string;
  colors?: {
    light?: ThemeColors;
    dark?: ThemeColors;
  };
  typography?: ThemeTypography;
  effects?: ThemeEffects;
  google_fonts_url?: string;
}

interface ThemePreviewMessage {
  type: 'THEME_PREVIEW' | 'THEME_RESET' | 'TOGGLE_DARK_MODE';
  theme?: ThemeConfig;
  mode?: 'light' | 'dark';
}

const STYLE_ELEMENT_ID = 'overskill-theme-preview';

// Store the original theme for reset
let savedTheme: ThemeConfig | null = null;

/**
 * Convert a snake_case color slot name to a kebab-case CSS variable name.
 */
function cssVarName(key: string): string {
  return `--${key.replace(/_/g, '-')}`;
}

/**
 * Build a CSS rules string for a single mode's color block.
 * Returns the rule body only (the contents that go between `{` and `}`).
 */
function colorsToCssBody(colors: ThemeColors | undefined): string {
  if (!colors) return '';
  return Object.entries(colors)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `  ${cssVarName(key)}: ${value};`)
    .join('\n');
}

/**
 * Build typography + effect declarations applied to :root (these are
 * identical across light/dark modes).
 */
function rootExtrasCss(theme: ThemeConfig): string {
  const lines: string[] = [];

  if (theme.typography?.font_sans) {
    lines.push(`  --font-sans: "${theme.typography.font_sans}", ui-sans-serif, system-ui, sans-serif;`);
  }
  if (theme.typography?.font_serif) {
    lines.push(`  --font-serif: "${theme.typography.font_serif}", ui-serif, Georgia, serif;`);
  }
  if (theme.typography?.font_mono) {
    lines.push(`  --font-mono: "${theme.typography.font_mono}", ui-monospace, monospace;`);
  }
  if (theme.effects?.radius !== undefined) {
    lines.push(`  --radius: ${theme.effects.radius}rem;`);
  }

  return lines.join('\n');
}

/**
 * Render the full <style> block contents for a previewed theme. Writes BOTH
 * :root and .dark selectors so that toggling dark mode reflects the previewed
 * theme correctly. We append this <style> last in <head>, so insertion-order
 * cascade ensures these rules win over the deployed stylesheet (same
 * specificity, later wins).
 */
function buildPreviewCss(theme: ThemeConfig): string {
  const lightBody = colorsToCssBody(theme.colors?.light);
  // Fall back to light colors for dark-mode preview only if dark wasn't
  // provided — most THEME_PREVIEW messages from the editor send both.
  const darkBody = colorsToCssBody(theme.colors?.dark || theme.colors?.light);
  const extras = rootExtrasCss(theme);

  const rootSection = [lightBody, extras].filter(Boolean).join('\n');

  // We mirror typography + radius onto .dark too so that even if the deployed
  // stylesheet redefines them in its .dark block, our preview still wins.
  const darkSection = [darkBody, extras].filter(Boolean).join('\n');

  return `/* overskill-theme-preview: ${theme.name || 'custom'} */
:root {
${rootSection}
}

.dark {
${darkSection}
}
`;
}

/**
 * Inject (or update) the preview <style> element with the rendered CSS.
 */
function injectPreviewCss(css: string) {
  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    // Append last so its rules win the cascade tiebreaker against the
    // deployed stylesheet.
    document.head.appendChild(style);
  }
  style.textContent = css;
}

/**
 * Remove the preview <style> element entirely — falls back to the deployed
 * stylesheet's values.
 */
function removePreviewCss() {
  const style = document.getElementById(STYLE_ELEMENT_ID);
  if (style) style.remove();
}

/**
 * Load Google Fonts dynamically
 */
function loadGoogleFonts(url: string) {
  // Check if already loaded
  const existingLink = document.querySelector(`link[href="${url}"]`);
  if (existingLink) return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  document.head.appendChild(link);
}

/**
 * Apply a complete theme configuration
 */
function applyTheme(theme: ThemeConfig) {
  console.log('[ThemePreview] Applying theme:', theme.name || 'custom');

  // Build a single <style> block with BOTH :root and .dark variables.
  // This is the core of Bug 2's fix — see file header.
  const css = buildPreviewCss(theme);
  injectPreviewCss(css);

  // Load fonts (separate <link>, idempotent)
  if (theme.google_fonts_url) {
    loadGoogleFonts(theme.google_fonts_url);
  }
}

/**
 * Handle incoming postMessage events
 */
function handleMessage(event: MessageEvent<ThemePreviewMessage>) {
  // Only accept messages from parent window (OverSkill editor)
  if (event.source !== window.parent) return;

  const { type, theme, mode } = event.data;

  if (type === 'THEME_PREVIEW' && theme) {
    // Save current theme on first preview (for reset)
    if (!savedTheme) {
      savedTheme = getCurrentTheme();
    }
    applyTheme(theme);
  } else if (type === 'THEME_RESET') {
    // Drop the preview overlay entirely; deployed CSS takes over.
    removePreviewCss();
    savedTheme = null;
  } else if (type === 'TOGGLE_DARK_MODE' && mode) {
    toggleDarkMode(mode);
  }
}

/**
 * Toggle dark mode on the document
 */
function toggleDarkMode(mode: 'light' | 'dark') {
  const root = document.documentElement;

  if (mode === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  console.log('[ThemePreview] Dark mode:', mode);
  // No re-apply needed — both :root and .dark are already in the injected
  // <style> block, so toggling the class swaps which one cascades.
}

/**
 * Get current theme from CSS variables (used to snapshot pre-preview state
 * so THEME_RESET can restore it). We only read what we expose; anything
 * unset on `:root` will round-trip back as an empty string and be ignored.
 */
function getCurrentTheme(): ThemeConfig {
  const root = document.documentElement;
  const computedStyle = getComputedStyle(root);

  const getVar = (name: string) => computedStyle.getPropertyValue(`--${name}`).trim();

  return {
    name: 'Current',
    colors: {
      light: {
        background: getVar('background'),
        foreground: getVar('foreground'),
        primary: getVar('primary'),
        primary_foreground: getVar('primary-foreground'),
        secondary: getVar('secondary'),
        secondary_foreground: getVar('secondary-foreground'),
        accent: getVar('accent'),
        accent_foreground: getVar('accent-foreground'),
        muted: getVar('muted'),
        muted_foreground: getVar('muted-foreground'),
        card: getVar('card'),
        card_foreground: getVar('card-foreground'),
        popover: getVar('popover'),
        popover_foreground: getVar('popover-foreground'),
        destructive: getVar('destructive'),
        destructive_foreground: getVar('destructive-foreground'),
        border: getVar('border'),
        input: getVar('input'),
        ring: getVar('ring'),
      }
    },
    effects: {
      radius: parseFloat(getVar('radius')) || 0.5
    }
  };
}

/**
 * Initialize the theme preview listener
 */
export function initThemePreview() {
  // Only initialize in iframe context (when embedded in OverSkill editor)
  if (window.parent === window) {
    console.log('[ThemePreview] Not in iframe, skipping initialization');
    return;
  }

  window.addEventListener('message', handleMessage);
  console.log('[ThemePreview] Initialized - listening for theme preview messages');
}

// Auto-initialize
initThemePreview();
