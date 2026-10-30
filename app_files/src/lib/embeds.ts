// Share URL -> PLAYER URL normalization for video embeds.
//
// WHY THIS EXISTS (Russell Brunson, #prj-overskill-feedback 2026-09-16)
// --------------------------------------------------------------------
// A creator copies a video link out of the provider's UI and pastes it into
// their app. What the provider's Copy button hands them is a SHARE/WATCH url,
// which is a full branded WEB PAGE — provider logo, chrome, related videos,
// sometimes a signup prompt. Framing that string in an <iframe> renders the
// provider's marketing page inside the creator's sales page:
//
//   https://share.voomly.com/v/<id>   -> Voomly's branded share page
//   https://embed.voomly.com/embed/assets/embed.html?videoId=<id>  -> bare player
//
// Every provider has this split (youtu.be vs /embed/, vimeo.com vs
// player.vimeo.com, wistia /medias/ vs fast.wistia.net/embed/iframe/,
// loom /share/ vs /embed/), so this is one helper rather than one fix.
//
// THE RULES THIS MODULE KEEPS
// --------------------------
//  1. RENDER-TIME ONLY. Never rewrite what the creator stored. Keep the
//     pasted string in the env var / entity field exactly as typed and call
//     this at the <iframe src={...}> boundary. Storing the derived URL means a
//     later provider change (or a bug in here) is baked into customer data.
//  2. PASS-THROUGH BY DEFAULT. An unrecognized host is returned unchanged.
//     Self-hosted players, an .mp4 on R2, and providers we have not mapped
//     must all keep working.
//  3. IDEMPOTENT. Feeding an already-normalized player URL back in returns it
//     untouched, so it is safe to call on every render and on stored values of
//     unknown provenance.
//  4. FAIL-OPEN. An unparseable string comes back as-is. A broken video is a
//     bad page; a thrown TypeError is a blank one.
//
// Deliberately DEPENDENCY-FREE (no React, no overskill-sdk, no
// import.meta.env) so it can be imported from anywhere, including a Worker,
// and so the vitest suite exercises the real function.

/** Voomly's bare-player endpoint. Its share page is a different host+path. */
const VOOMLY_EMBED = "https://embed.voomly.com/embed/assets/embed.html";

// A Voomly video id is opaque but URL-safe, and REAL ids contain `_` and `-`
// (e.g. `npJWoBjXHhqFkEFSn_guRcnGBAWtI0YvyMSVaCYe0fpzTlEcA`, shipped in the
// platform's own clip registry). A letters+digits-only pattern silently fails
// to find the id on those links and falls through to the share page, which is
// the exact bug this module exists to fix. The length floor is what keeps it
// from matching a path segment like `v` or `watch`.
const VOOMLY_ID = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Is `host` this registrable domain, or a subdomain of it?
 *
 * A bare `host.endsWith("vimeo.com")` also matches `shareyourvimeo.com`, and
 * `endsWith("loom.com")` matches `myloom.com` — so a third party's URL whose
 * path happens to start with digits would get silently rewritten onto
 * player.vimeo.com. Pass-through is only trustworthy if the provider match is
 * exact, and every real provider host is either the apex or a subdomain of it
 * (`share.voomly.com`, `<acct>.wistia.com`), so nothing legitimate is lost.
 */
const hostIs = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * Normalize a pasted video URL to the provider's embeddable PLAYER url.
 *
 * Supports YouTube (incl. youtu.be, /shorts/, /live/, -nocookie), Vimeo
 * (incl. unlisted hashes), Wistia, Loom and Voomly. Anything else is returned
 * unchanged.
 *
 * @param raw - whatever the creator pasted (share url, watch url, embed url)
 * @returns an embeddable URL, or the input unchanged when we cannot improve it
 */
export function toEmbedUrl(raw: string | null | undefined): string {
  const input = (typeof raw === "string" ? raw : "").trim();
  if (!input) return "";

  // Creators paste bare hosts ("youtu.be/abc") and protocol-relative URLs
  // ("//player.vimeo.com/..."). Both are valid src values in a browser but
  // neither parses with `new URL`, so give the parser a scheme to work with.
  const withProtocol = /^https?:\/\//i.test(input)
    ? input
    : `https://${input.replace(/^\/\//, "")}`;

  let u: URL;
  try {
    u = new URL(withProtocol);
  } catch {
    // Not a URL at all (a title, a note, a half-typed string). Hand it back
    // untouched rather than inventing a link.
    return input;
  }

  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  // ---------------------------------------------------------------- YouTube
  if (host === "youtu.be") {
    const id = parts[0];
    return id ? `https://www.youtube.com/embed/${id}` : withProtocol;
  }
  if (hostIs(host, "youtube.com") || hostIs(host, "youtube-nocookie.com")) {
    if (u.pathname.startsWith("/embed/")) return withProtocol;

    // Keep a privacy-enhanced link privacy-enhanced: a nocookie input must
    // never be rewritten onto the tracking host. (youtube-nocookie.com only
    // ever serves /embed/, so this branch is defensive rather than observed.)
    const origin = hostIs(host, "youtube-nocookie.com")
      ? "https://www.youtube-nocookie.com"
      : "https://www.youtube.com";

    const v = u.searchParams.get("v");
    if (v) return `${origin}/embed/${v}`;
    if ((parts[0] === "shorts" || parts[0] === "live") && parts[1]) {
      return `${origin}/embed/${parts[1]}`;
    }
    return withProtocol;
  }

  // ------------------------------------------------------------------ Vimeo
  if (host === "player.vimeo.com") return withProtocol;
  if (hostIs(host, "vimeo.com")) {
    const id = parts[0];
    if (/^\d+$/.test(id ?? "")) {
      // An unlisted video's second path segment is its privacy hash, and the
      // player REQUIRES it as ?h= or it answers 404.
      const hash = parts[1];
      return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`;
    }
    return withProtocol;
  }

  // ----------------------------------------------------------------- Wistia
  if (hostIs(host, "wistia.com") || hostIs(host, "wistia.net")) {
    if (u.pathname.includes("/embed/")) return withProtocol;
    const m = u.pathname.match(/\/medias\/([A-Za-z0-9]+)/);
    if (m) return `https://fast.wistia.net/embed/iframe/${m[1]}`;
    return withProtocol;
  }

  // ------------------------------------------------------------------- Loom
  if (hostIs(host, "loom.com")) {
    const m = u.pathname.match(/\/share\/([A-Za-z0-9-]+)/);
    if (m) return `https://www.loom.com/embed/${m[1]}`;
    return withProtocol;
  }

  // ----------------------------------------------------------------- Voomly
  if (hostIs(host, "voomly.com")) {
    // Already the bare player — idempotent, and it carries the creator's own
    // skin/ratio params which must survive.
    if (host === "embed.voomly.com" && u.pathname.includes("/assets/embed.html")) {
      return withProtocol;
    }

    const id =
      u.searchParams.get("videoId") || parts.find((p) => VOOMLY_ID.test(p));

    if (id) {
      // embed.html reads only videoId, videoRatio, type, presentation,
      // skinColor and isNativeFullscreen — anything else (an invented
      // `autoplay=1`) is dropped silently. `skinColor` is a literal `#`, which
      // URLSearchParams escapes to %23 for us.
      const params = new URLSearchParams({
        videoId: id,
        videoRatio: "1.777778",
        type: "v",
        skinColor: "#008EFF",
      });
      return `${VOOMLY_EMBED}?${params.toString()}`;
    }
    return withProtocol;
  }

  // Unknown provider, self-hosted player, direct media file: unchanged.
  return withProtocol;
}

export default toEmbedUrl;
