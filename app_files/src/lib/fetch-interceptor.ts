/**
 * Fetch interceptor that logs authentication and network errors for AI debugging
 * This catches 401/404 errors that might not be explicitly logged by application code
 *
 * CRITICAL: This must be imported BEFORE any other code that makes fetch requests
 * CRITICAL: Excludes iframe_bridge URLs to prevent recursive error loops
 *
 * Phase 1 Enhancement (Jan 2026): Detects Overskill API errors and enables
 * "Ask AI to Fix" functionality in preview mode via error-reporter.ts
 */

import { detectOverskillError, showErrorToast, isPreviewMode, isBackgroundEndpoint } from './error-reporter';

// CRITICAL DEBUG: Log immediately when this module loads
console.log('[FetchInterceptor] 🚀 MODULE LOADED - fetch-interceptor.ts is being executed');
console.log('[FetchInterceptor] 🔍 isPreviewMode at load time:', isPreviewMode());
console.log('[FetchInterceptor] 🌐 Current hostname:', window.location.hostname);
console.log('[FetchInterceptor] 🖼️ In iframe:', window.self !== window.top);

const originalFetch = window.fetch;

// Store request body for error reporting context
let lastRequestBody: any = null;

window.fetch = async function(...args: Parameters<typeof fetch>): Promise<Response> {
  const [resource, config] = args;
  const url = typeof resource === 'string' ? resource : resource.url;
  const method = config?.method || 'GET';

  // Store request body for error context (if JSON)
  lastRequestBody = null;
  if (config?.body) {
    try {
      if (typeof config.body === 'string') {
        lastRequestBody = JSON.parse(config.body);
      }
    } catch (e) {
      // Not JSON, ignore
    }
  }

  // CRITICAL: Don't intercept iframe_bridge calls to prevent recursive error loops!
  // If iframe bridge fails, we don't want to log that failure back to iframe bridge
  if (url.includes('/iframe_bridge/')) {
    return originalFetch.apply(this, args);  // Pass through without logging
  }

  try {
    const response = await originalFetch.apply(this, args);

    // Check for Overskill-specific errors with __overskill_error flag
    // This enables "Ask AI to Fix" functionality in preview mode
    if (!response.ok) {
      console.log('[FetchInterceptor] ❌ NON-OK RESPONSE DETECTED', {
        status: response.status,
        statusText: response.statusText,
        url,
        method,
        contentType: response.headers.get('content-type')
      });

      try {
        const overskillError = await detectOverskillError(response);
        console.log('[FetchInterceptor] 🔍 detectOverskillError result:', overskillError ? 'FOUND ERROR OBJECT' : 'null/not found');

        if (overskillError) {
          console.log('[FetchInterceptor] ✅ OVERSKILL ERROR DETECTED:', {
            error: overskillError.error,
            category: overskillError.category,
            __overskill_error: overskillError.__overskill_error
          });

          console.error(
            `🛠️ [OverSkill Error] ${overskillError.category || 'API_ERROR'}: ${method} ${url}`,
            {
              url,
              method,
              status: response.status,
              error: overskillError.error,
              category: overskillError.category,
              suggestion: overskillError.suggestion,
              invalidColumns: overskillError.invalidColumns,
              validColumns: overskillError.validColumns,
              timestamp: new Date().toISOString()
            }
          );

          // Show enhanced toast with "Ask AI to Fix" button in preview mode.
          //
          // EXCEPTION (Jul 2026, ticket #752): background/polling reads
          // (e.g. the SDK's 30s /api/me/entitlements poll) never toast —
          // a persistent failure would otherwise pop a toast per poll tick
          // per mounted consumer. showErrorToast() double-checks this, but
          // we also skip here so the intent is visible at the call site.
          // The console.error above still fires for AI debugging.
          if (isBackgroundEndpoint(url)) {
            console.log('[FetchInterceptor] 🤫 Background endpoint — skipping error toast', { url });
            return response;
          }
          console.log('[FetchInterceptor] 📣 CALLING showErrorToast...');
          showErrorToast(overskillError, {
            url,
            method,
            requestBody: lastRequestBody
          });
          console.log('[FetchInterceptor] 📣 showErrorToast CALLED');

          return response;
        } else {
          console.log('[FetchInterceptor] ⚠️ detectOverskillError returned null - no __overskill_error flag found');
        }
      } catch (detectError) {
        console.error('[FetchInterceptor] 💥 ERROR in detectOverskillError:', detectError);
      }
    }

    // Log 401 Unauthorized errors (authentication issues)
    if (response.status === 401) {
      console.error(
        `🔒 [Auth Error] 401 Unauthorized: ${method} ${url}`,
        {
          url,
          method,
          status: 401,
          timestamp: new Date().toISOString(),
          hasAuthHeader: !!(config?.headers as any)?.['Authorization'],
          suggestion: 'User needs to log in. Check VITE_APP_VISIBILITY setting and authentication state.'
        }
      );
    }

    // Log 404 Not Found errors (missing resources/endpoints)
    if (response.status === 404) {
      console.error(
        `❌ [Not Found] 404: ${method} ${url}`,
        {
          url,
          method,
          status: 404,
          timestamp: new Date().toISOString(),
          suggestion: 'Resource or endpoint does not exist. Check if the file/route is deployed correctly.'
        }
      );
    }

    // Log 403 Forbidden errors (permission issues)
    if (response.status === 403) {
      console.error(
        `🚫 [Forbidden] 403: ${method} ${url}`,
        {
          url,
          method,
          status: 403,
          timestamp: new Date().toISOString(),
          suggestion: 'Permission denied. User may not have access to this resource.'
        }
      );
    }

    // Log other client errors (400-499)
    if (response.status >= 400 && response.status < 500 && ![401, 403, 404].includes(response.status)) {
      console.warn(
        `⚠️ [Client Error] ${response.status}: ${method} ${url}`,
        {
          url,
          method,
          status: response.status,
          statusText: response.statusText
        }
      );
    }

    // Log server errors (500-599)
    if (response.status >= 500) {
      console.error(
        `💥 [Server Error] ${response.status}: ${method} ${url}`,
        {
          url,
          method,
          status: response.status,
          statusText: response.statusText,
          suggestion: 'Server-side error. Check API logs or contact support.'
        }
      );
    }

    return response;
  } catch (error) {
    // Log network errors (CORS, timeout, offline, etc.)
    console.error(
      `🌐 [Network Error] Request failed: ${method} ${url}`,
      {
        url,
        method,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
        suggestion: 'Network request failed. Check internet connection or CORS configuration.'
      }
    );
    throw error;
  }
};

console.log('[OverSkill] 🔍 Fetch interceptor enabled for error detection', {
  previewMode: isPreviewMode(),
  askAiToFix: isPreviewMode() ? 'enabled' : 'disabled'
});

export {}; // Make it a module

