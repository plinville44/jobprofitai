"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { gpcOn, gtmBootstrap, leavesTaggedPages, tagsAllowedOnPath, trackingAllowed } from "@/lib/tracking";

/**
 * Loads Google Tag Manager on the pages src/lib/tracking.ts allows, when the
 * visitor hasn't opted out and the browser doesn't send Global Privacy
 * Control. Mounted once in the root layout. Renders nothing, and does
 * nothing at all until NEXT_PUBLIC_GTM_ID is set.
 *
 * A script can't be unloaded from a page, and Next.js moves between pages
 * without reloading. So once the tags are loaded, any move to a page where
 * they aren't allowed (logging in, the dashboard) becomes a full page load,
 * caught before the tags can see it: history.pushState and replaceState are
 * wrapped before GTM loads (GTM wraps them after us, so the address never
 * changes in-page and its history trigger has nothing to report), and the
 * Back button is caught first in the capture phase, which also stops the
 * tags' own listeners. The pathname check below is the last line of defense.
 */
function guardLeavingTaggedPages(): void {
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = function (data: unknown, unused: string, url?: string | URL | null): void {
      if (leavesTaggedPages(window.location.href, url)) {
        window.__jpaiLeaving = true;
        window.location.assign(new URL(String(url), window.location.href).href);
        return;
      }
      original(data, unused, url);
    };
  }
  window.addEventListener(
    "popstate",
    (event) => {
      if (tagsAllowedOnPath(window.location.pathname)) return;
      event.stopImmediatePropagation();
      window.__jpaiLeaving = true;
      window.location.reload();
    },
    true
  );
}

const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID ?? "";

declare global {
  interface Window {
    __jpaiTagsLoaded?: boolean;
    /** A full page load out of the tagged pages is already under way. */
    __jpaiLeaving?: boolean;
  }
}

export default function MarketingTags() {
  const pathname = usePathname() ?? "/";

  useEffect(() => {
    const script = gtmBootstrap(GTM_ID);
    if (!script) return;
    const allowedHere = tagsAllowedOnPath(pathname);

    if (window.__jpaiTagsLoaded) {
      // Last line of defense: the router moved on without going through the
      // guards above. Load the page it moved to afresh (the address may not
      // have changed yet, so not reload()), unless a guard already is.
      if (!allowedHere && !window.__jpaiLeaving) {
        window.__jpaiLeaving = true;
        window.location.assign(pathname);
      }
      return;
    }
    if (!allowedHere) return;
    if (!trackingAllowed({ gpc: gpcOn(navigator as unknown as { globalPrivacyControl?: unknown }), cookieHeader: document.cookie })) {
      return;
    }

    guardLeavingTaggedPages();
    const el = document.createElement("script");
    el.id = "jpai-gtm";
    el.textContent = script;
    document.head.appendChild(el);
    window.__jpaiTagsLoaded = true;
  }, [pathname]);

  return null;
}
