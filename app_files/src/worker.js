// Cloudflare Worker entry point for SPA deployment
// This worker serves static assets, handles SPA routing, and provides edge auth

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle API routes - auth and data endpoints
    if (path.startsWith('/api/')) {
      return handleApiRequest(request, path, env);
    }

    // Try to fetch the asset from the Workers Assets binding
    // This will handle all static files (JS, CSS, images, fonts, etc.)
    try {
      const assetResponse = await env.ASSETS.fetch(request);

      // If asset found, return it
      if (assetResponse.status !== 404) {
        return assetResponse;
      }

      // Asset not found - check if this looks like a page route (SPA fallback)
      // If the path doesn't have a file extension, serve index.html for client-side routing
      const hasFileExtension = path.includes('.') && !path.endsWith('/');

      if (!hasFileExtension) {
        // This is a page route (e.g., /checkout, /about, /products/123)
        // Serve index.html and let React Router handle the routing
        const indexRequest = new Request(new URL('/', request.url), request);
        return env.ASSETS.fetch(indexRequest);
      }

      // If it has a file extension and wasn't found, it's truly a 404
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      // If ASSETS binding fails, return error
      return new Response(`Worker Error: ${error.message}`, { status: 500 });
    }
  }
};

// =============================================================================
// API Request Handler
// =============================================================================

async function handleApiRequest(request, path, env) {
  // CORS headers for API requests
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Auth endpoints - validated at edge for resilience
  if (path === '/api/auth/me') {
    return handleAuthMe(request, corsHeaders);
  }

  if (path === '/api/auth/validate') {
    return handleAuthValidate(request, corsHeaders);
  }

  // Default: API endpoint not implemented
  return new Response(
    JSON.stringify({ error: 'API endpoint not found', path }),
    { status: 404, headers: corsHeaders }
  );
}

// =============================================================================
// Edge Authentication - JWT Validation without Backend
// =============================================================================

/**
 * Handle /api/auth/me - Return current user from JWT
 * This validates the token at the edge without calling Rails
 */
async function handleAuthMe(request, corsHeaders) {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({
        authenticated: false,
        error: 'No authorization token provided'
      }),
      { status: 401, headers: corsHeaders }
    );
  }

  const token = authHeader.substring(7); // Remove 'Bearer '
  const result = validateJWT(token);

  if (!result.valid) {
    return new Response(
      JSON.stringify({
        authenticated: false,
        error: result.error
      }),
      { status: 401, headers: corsHeaders }
    );
  }

  // Return user info from token payload.
  //
  // NOTE: in production this file is NOT the worker that serves /api/auth/me —
  // WFP deploys always generate the live worker from the platform's
  // Deployment::WorkerApiTemplate (see WorkerScriptAssembler), whose
  // handleAuthMe is the authoritative implementation. Keep this scaffold's
  // response shape aligned with it: the app's src/lib/auth.ts helpers
  // (hasRole/hasPermission/getUserPermissions) read user.app_context.*, so a
  // response that omits app_context silently disables every client-side
  // role/permission check. app_id/app_user_id live INSIDE app_context in the
  // minted JWT (OverskillJwtService.generate_for_app_user), not top-level.
  const appContext = result.payload.app_context || {};
  // OS-7E39Q8 (Jul 2026): `id` MUST use the same precedence the authoritative
  // WorkerApiTemplate handleAuthMe uses (app_user_id-first, `sub` only as a
  // legacy-token fallback). `sub` is users.id while every row-ownership and
  // participant gate is keyed on app_users.id — echoing `sub` here makes the
  // client believe it is a different user than the server does, which produces
  // repeating 403s on participant-gated polls and own-vs-other render bugs.
  const effectiveUserId =
    appContext.app_user_id ?? result.payload.app_user_id ?? result.payload.sub;
  return new Response(
    JSON.stringify({
      authenticated: true,
      user: {
        id: effectiveUserId == null ? undefined : String(effectiveUserId),
        email: result.payload.email,
        name: result.payload.name,
        app_id: appContext.app_id,
        app_user_id: appContext.app_user_id,
        // Flat copies for backward compatibility (direct user.roles access)
        roles: appContext.roles || [],
        permissions: appContext.permissions || {},
        // Full app-scoped authorization context minted into the JWT
        // (app_id, app_user_id, team_id, roles, permissions, is_creator,
        // is_team_member) — consumed by src/lib/auth.ts and useRoles.
        app_context: result.payload.app_context
      }
    }),
    { status: 200, headers: corsHeaders }
  );
}

/**
 * Handle /api/auth/validate - Validate token and return status
 * Useful for checking token validity without full user lookup
 */
async function handleAuthValidate(request, corsHeaders) {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(
      JSON.stringify({ valid: false, error: 'No token provided' }),
      { status: 200, headers: corsHeaders }
    );
  }

  const token = authHeader.substring(7);
  const result = validateJWT(token);

  return new Response(
    JSON.stringify({
      valid: result.valid,
      error: result.error || null,
      expires_at: result.payload?.exp ? new Date(result.payload.exp * 1000).toISOString() : null
    }),
    { status: 200, headers: corsHeaders }
  );
}

/**
 * Validate JWT token at the edge
 *
 * NOTE: This performs structural validation and expiration check only.
 * For signature verification, you would need to:
 * 1. Use asymmetric keys (RS256) with public key at edge, OR
 * 2. Store symmetric key in Workers secrets
 *
 * Current approach is suitable for:
 * - Session validation (token was issued by trusted source)
 * - Expiration checking
 * - User info extraction
 *
 * @param {string} token - JWT token string
 * @returns {{ valid: boolean, error?: string, payload?: object }}
 */
function validateJWT(token) {
  try {
    // Split JWT into parts
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid token format' };
    }

    // Decode payload (middle part)
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

    // Check required fields
    if (!payload.sub || !payload.exp) {
      return { valid: false, error: 'Token missing required fields' };
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return {
        valid: false,
        error: 'Token expired',
        payload // Include payload so caller can see when it expired
      };
    }

    // Check issued at (if present) - token shouldn't be from the future
    if (payload.iat && payload.iat > now + 60) { // 60 second grace for clock skew
      return { valid: false, error: 'Token issued in the future' };
    }

    // Token is structurally valid and not expired
    return { valid: true, payload };

  } catch (error) {
    return { valid: false, error: `Token decode error: ${error.message}` };
  }
}