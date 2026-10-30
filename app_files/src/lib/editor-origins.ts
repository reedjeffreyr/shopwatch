// Mirrored from config/platform_origins.json; parity is checked by the platform tests.
import origins from './platform-origins.json'

export const editorOrigins = [...origins.overskill, ...origins.clickfunnels, ...origins.preview]

// Exact origins only (#7848). Never a wildcard such as *.overskill.com: other
// hosts on that domain serve content the editor does not control.
export function isEditorOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false
  return editorOrigins.includes(origin) || isLocalDevelopmentEditor(origin)
}

// Local platform development: a localhost editor is trusted only when this
// app is itself served from the developer's machine, never in a deployed app.
function isLocalDevelopmentEditor(origin: string): boolean {
  const hostname = typeof window === 'undefined' ? '' : window.location?.hostname || ''
  return /^(?:localhost|127\.0\.0\.1)$/.test(hostname) &&
    /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/.test(origin)
}
