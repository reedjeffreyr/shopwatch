import React, { useState } from "react";

/**
 * <AppBrand/> — the app's header brand mark (logo/wordmark) primitive.
 *
 * WHAT IT DOES:
 *   - If the user uploaded a brand logo in OverSkill Settings, the platform
 *     exposes it as `import.meta.env.VITE_APP_LOGO_URL`. When that's set,
 *     AppBrand renders it as an `<img data-app-icon>` — so the header shows
 *     the real logo AND the favicon capture picks it up automatically.
 *   - When no logo is set (or the image fails to load), it gracefully falls
 *     back to the inline mark: an optional icon badge (`icon` prop, tagged
 *     `data-app-icon`) next to the app name — exactly the classic pattern.
 *
 * THIS IS A DEFAULT, NOT A CAGE: restyle it, move it, pass your own icon
 * badge, or delete it and hand-roll a mark (keep `data-app-icon` on one
 * small element if you do — see the App Icon rules).
 *
 * Props:
 *   name          — the app's display name / wordmark text (required)
 *   icon          — optional inline fallback mark (e.g. a lucide icon inside
 *                   a styled badge). Rendered only when no logo image shows.
 *   className     — classes for the fallback wordmark/wrapper
 *   imgClassName  — classes for the logo <img> (default "h-8 w-auto")
 */
export interface AppBrandProps {
  name: string;
  icon?: React.ReactNode;
  className?: string;
  imgClassName?: string;
}

export default function AppBrand({ name, icon, className, imgClassName }: AppBrandProps) {
  const logoUrl = import.meta.env.VITE_APP_LOGO_URL as string | undefined;
  const [imgFailed, setImgFailed] = useState(false);

  if (logoUrl && !imgFailed) {
    return (
      <img
        src={logoUrl}
        alt={`${name} logo`}
        data-app-icon
        className={imgClassName ?? "h-8 w-auto object-contain"}
        onError={() => setImgFailed(true)}
      />
    );
  }

  if (icon) {
    return (
      <span className={className ?? "flex items-center gap-2"}>
        <span data-app-icon className="grid place-items-center w-9 h-9 rounded-xl bg-primary text-primary-foreground">
          {icon}
        </span>
        <span className="font-semibold text-foreground">{name}</span>
      </span>
    );
  }

  // Plain wordmark fallback — renders identically to the classic
  // `<h1 className="...">My App</h1>` header when no logo and no icon.
  return <h1 className={className ?? "text-lg font-semibold text-foreground"}>{name}</h1>;
}
