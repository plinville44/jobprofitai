"use client";

import { useState } from "react";

/**
 * Intuit's approved button graphics (App Store technical requirement 1.3:
 * "All Intuit and QuickBooks logos and buttons in your app use the approved
 * and provided images").
 *
 * The images are Intuit's, downloaded from the Intuit Developer site and
 * saved under public/intuit/ with the names below. Until they are there
 * (or if one fails to load) a plain text button stands in so nothing is
 * ever blank, but the listing review expects the real images.
 */
const CONNECT_IMG = "/intuit/connect-to-quickbooks.svg";
const SIGN_IN_IMG = "/intuit/sign-in-with-intuit.svg";

function ImageButton({
  href,
  src,
  alt,
  height,
  fallbackClass,
}: {
  href: string;
  src: string;
  alt: string;
  height: number;
  fallbackClass: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <a href={href} className="inline-block" aria-label={alt}>
      {failed ? (
        <span className={fallbackClass}>{alt}</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} style={{ height }} className="w-auto" onError={() => setFailed(true)} />
      )}
    </a>
  );
}

/** The Connect to QuickBooks button. `href` defaults to a new connection. */
export function ConnectToQuickBooksButton({ href = "/api/quickbooks/connect" }: { href?: string }) {
  return (
    <ImageButton
      href={href}
      src={CONNECT_IMG}
      alt="Connect to QuickBooks"
      height={40}
      fallbackClass="inline-block rounded-lg bg-[#2CA01C] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#248a17]"
    />
  );
}

/** The Sign in with Intuit button, on every sign-in page. */
export function SignInWithIntuitButton({ intent = "signin" }: { intent?: "signin" | "appstore" }) {
  return (
    <ImageButton
      href={`/api/auth/intuit?intent=${intent}`}
      src={SIGN_IN_IMG}
      alt="Sign in with Intuit"
      height={40}
      fallbackClass="inline-block rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-[#0077C5] hover:bg-gray-50"
    />
  );
}
