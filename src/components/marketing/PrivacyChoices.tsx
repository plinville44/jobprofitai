"use client";

import { useEffect, useState } from "react";
import {
  OPT_OUT_COOKIE,
  OPT_OUT_MAX_AGE_SECONDS,
  cookieDomainsFor,
  gpcOn,
  marketingCookieNames,
  optedOutByCookie,
} from "@/lib/tracking";

/**
 * The switch on /privacy-choices. Turning the tags off sets the jpai_optout
 * cookie, saves the choice on the account if someone is signed in, clears
 * the first-party cookies the tags set, and reloads the page so Google Tag
 * Manager is gone (src/components/MarketingTags.tsx won't load it again).
 * A browser sending Global Privacy Control is shown that its signal was
 * honored, as the California regulations ask, and can't switch the tags back
 * on while the signal is on.
 */
type Status = { gpc: boolean; optedOut: boolean };

/** Saves the choice on the account when signed in (src/app/api/privacy/ad-opt-out). Never blocks the page. */
async function saveOnAccount(optOut: boolean): Promise<void> {
  try {
    await fetch("/api/privacy/ad-opt-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optOut }),
    });
  } catch {
    // Signed out, offline or blocked: the browser choice still stands.
  }
}

async function setOptOut(on: boolean) {
  await saveOnAccount(on);
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = on
    ? `${OPT_OUT_COOKIE}=1; Max-Age=${OPT_OUT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`
    : `${OPT_OUT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  if (on) {
    for (const name of marketingCookieNames(document.cookie)) {
      document.cookie = `${name}=; Max-Age=0; Path=/`;
      for (const domain of cookieDomainsFor(window.location.hostname)) {
        document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${domain}`;
      }
    }
  }
  window.location.reload();
}

export default function PrivacyChoices() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    const gpc = gpcOn(navigator as unknown as { globalPrivacyControl?: unknown });
    setStatus({ gpc, optedOut: optedOutByCookie(document.cookie) });
    // A signed-in visitor sending GPC: save it on the account too.
    if (gpc) void saveOnAccount(true);
  }, []);

  if (!status) {
    return (
      <div className="rounded-xl border border-jp-line bg-jp-surface px-5 py-4 text-[15px] text-jp-slate">
        Checking this browser&rsquo;s settings.
      </div>
    );
  }

  if (status.gpc) {
    return (
      <div className="rounded-xl border border-jp-blue/30 bg-jp-surface px-5 py-4 text-[15px] leading-relaxed text-jp-slate">
        <p className="font-semibold text-jp-ink">Global Privacy Control signal received and honored</p>
        <p className="mt-2">
          Your browser is sending a Global Privacy Control signal. We treat it as a request to opt out
          of the sale or sharing of your personal information and of targeted advertising, so our
          analytics and advertising tags don&rsquo;t load in this browser. You don&rsquo;t need to do
          anything else here.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-jp-line bg-jp-surface px-5 py-4 text-[15px] leading-relaxed text-jp-slate">
      <p className="font-semibold text-jp-ink">
        Analytics and advertising in this browser: {status.optedOut ? "off" : "on"}
      </p>
      <p className="mt-2">
        {status.optedOut
          ? "You’ve turned off our analytics and advertising tags in this browser. They won’t load on our website while this choice is saved."
          : "Our website pages can load Google Analytics, which also measures our Google Ads, in this browser. Turning it off also opts you out of the sale or sharing of your personal information and of targeted advertising through our website."}
      </p>
      <button
        type="button"
        onClick={() => void setOptOut(!status.optedOut)}
        className={
          status.optedOut
            ? "mt-4 inline-flex items-center rounded-lg border border-jp-line bg-white px-4 py-2.5 text-sm font-semibold text-jp-ink transition-colors hover:border-jp-blue hover:text-jp-blue"
            : "mt-4 inline-flex items-center rounded-lg bg-jp-blue px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-jp-navy"
        }
      >
        {status.optedOut ? "Turn them back on" : "Turn off analytics and advertising"}
      </button>
    </div>
  );
}
