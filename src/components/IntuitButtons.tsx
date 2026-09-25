"use client";

import { useState } from "react";

/**
 * Intuit's approved button graphics (App Store technical requirement 1.3:
 * "All Intuit and QuickBooks logos and buttons in your app use the approved
 * and provided images").
 *
 * Both images are Intuit's own files, saved unchanged under public/intuit/:
 *   connect-to-quickbooks.png  static.developer.intuit.com/images/C2QB_green_btn_lg_default.png
 *                              (550x96, drawn at half size so it stays sharp on high-density screens)
 *   sign-in-with-intuit.png    appcenter.intuit.com/Content/IA/button_signinwithintuit_horiz_large.png
 *                              (200x43)
 * Don't redraw, recolor, crop or restyle them, and don't put the QuickBooks
 * logo anywhere else by hand. The whole image is the link.
 *
 * If an image ever fails to load, a plain text button stands in (text only,
 * no logo) so the page is never left without a way to connect or sign in.
 */
const CONNECT_IMG = { src: "/intuit/connect-to-quickbooks.png", width: 275, height: 48 };
const SIGN_IN_IMG = { src: "/intuit/sign-in-with-intuit.png", width: 200, height: 43 };

function ImageButton({
  href,
  img,
  alt,
  fallbackClass,
}: {
  href: string;
  img: { src: string; width: number; height: number };
  alt: string;
  fallbackClass: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <a
      href={href}
      className="inline-block max-w-full rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2CA01C]"
    >
      {failed ? (
        <span className={fallbackClass}>{alt}</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={img.src}
          alt={alt}
          width={img.width}
          height={img.height}
          style={{ width: img.width, maxWidth: "100%", height: "auto" }}
          className="block"
          onError={() => setFailed(true)}
        />
      )}
    </a>
  );
}

/**
 * The Connect to QuickBooks button: Intuit's green button image, and the
 * whole of it starts the QuickBooks connection (/api/quickbooks/connect).
 * `href` defaults to a new connection; pass the reconnect link to repair one.
 */
export function ConnectToQuickBooksButton({ href = "/api/quickbooks/connect" }: { href?: string }) {
  return (
    <ImageButton
      href={href}
      img={CONNECT_IMG}
      alt="Connect to QuickBooks"
      fallbackClass="inline-block rounded-lg bg-[#2CA01C] px-6 py-3 text-base font-semibold text-white hover:bg-[#248a17]"
    />
  );
}

/** The Sign in with Intuit button, on every sign-in page. */
export function SignInWithIntuitButton({ intent = "signin" }: { intent?: "signin" | "appstore" }) {
  return (
    <ImageButton
      href={`/api/auth/intuit?intent=${intent}`}
      img={SIGN_IN_IMG}
      alt="Sign in with Intuit"
      fallbackClass="inline-block rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-[#0077C5] hover:bg-gray-50"
    />
  );
}
