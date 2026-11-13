"use client";

import { useState } from "react";

/**
 * Intuit's approved button graphics (App Store technical requirement 1.3:
 * "All Intuit and QuickBooks logos and buttons in your app use the approved
 * and provided images").
 *
 * The files are Intuit's own, from the button sets Intuit's reviewer sent on
 * Nov 13, 2026 (Connect_to_QuickBooks_buttons.zip and
 * Sign_in_with_Intuit_buttons.zip), saved unchanged under public/intuit/
 * with Intuit's file names:
 *   C2QB_green_btn_tall_default.svg / _hover.svg   274x48, green
 *   Sign_in_blue_btn_tall_default.svg / _hover.svg 201x48, white on blue
 * The older images (C2QB_green_btn_lg_default.png and
 * button_signinwithintuit_horiz_large.png) were turned down in review.
 * Don't redraw, recolor, crop or restyle them. The whole image is the link,
 * and the hover file shows on hover and keyboard focus, as Intuit supplies
 * both.
 *
 * Where they go (Intuit's review, Nov 13, 2026):
 * - Connect to QuickBooks is the only way an OAuth connection starts. With
 *   no company connected it shows as is; once one is, it's hidden behind an
 *   "Add company" button (AddCompanyButton, requirement 6.2), apart from
 *   the reconnect button on a company whose connection needs repairing.
 * - Sign in with Intuit is on the login page only, never on signup.
 *
 * If an image ever fails to load, a plain text button stands in (text only)
 * so the page is never left without a way to connect or sign in.
 */
type ButtonImage = { src: string; hover: string; width: number; height: number };

const CONNECT_IMG: ButtonImage = {
  src: "/intuit/C2QB_green_btn_tall_default.svg",
  hover: "/intuit/C2QB_green_btn_tall_hover.svg",
  width: 274,
  height: 48,
};
const SIGN_IN_IMG: ButtonImage = {
  src: "/intuit/Sign_in_blue_btn_tall_default.svg",
  hover: "/intuit/Sign_in_blue_btn_tall_hover.svg",
  width: 201,
  height: 48,
};

function ImageButton({
  href,
  img,
  alt,
  fallbackClass,
}: {
  href: string;
  img: ButtonImage;
  alt: string;
  fallbackClass: string;
}) {
  const [failed, setFailed] = useState(false);
  const size = { width: img.width, maxWidth: "100%", height: "auto" } as const;
  return (
    <a
      href={href}
      className="group inline-block max-w-full rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077C5]"
    >
      {failed ? (
        <span className={fallbackClass}>{alt}</span>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img.src}
            alt={alt}
            width={img.width}
            height={img.height}
            style={size}
            className="block group-hover:hidden group-focus-visible:hidden"
            onError={() => setFailed(true)}
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img.hover}
            alt=""
            aria-hidden="true"
            width={img.width}
            height={img.height}
            style={size}
            className="hidden group-hover:block group-focus-visible:block"
            onError={() => setFailed(true)}
          />
        </>
      )}
    </a>
  );
}

/**
 * The Connect to QuickBooks button: Intuit's green button, and the whole of
 * it starts the QuickBooks connection (/api/quickbooks/connect). `href`
 * defaults to a new connection; pass the reconnect link to repair one.
 */
export function ConnectToQuickBooksButton({ href = "/api/quickbooks/connect" }: { href?: string }) {
  return (
    <ImageButton
      href={href}
      img={CONNECT_IMG}
      alt="Connect to QuickBooks"
      fallbackClass="inline-block rounded bg-[#2CA01C] px-6 py-3 text-base font-semibold text-white hover:bg-[#248a17]"
    />
  );
}

/**
 * The Sign in with Intuit button, for the login page only (Intuit's review,
 * Nov 13, 2026). It opens Intuit's OpenID sign-in (/api/auth/intuit).
 */
export function SignInWithIntuitButton() {
  return (
    <ImageButton
      href="/api/auth/intuit?intent=signin"
      img={SIGN_IN_IMG}
      alt="Sign in with Intuit"
      fallbackClass="inline-block rounded bg-[#0077C5] px-5 py-3 text-base font-semibold text-white hover:bg-[#00589a]"
    />
  );
}

/**
 * "Add company" (Intuit's technical requirement 6.2): once a company is
 * connected, the Connect to QuickBooks button stays hidden until this is
 * clicked. After the new company is authorized it's listed with its own
 * Disconnect button, and the page shows only Add company again.
 */
export function AddCompanyButton() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-navy hover:bg-gray-50"
      >
        Add company
      </button>
    );
  }
  return (
    <div>
      <p className="text-sm text-gray-600">Choose Connect to QuickBooks, sign in to Intuit and pick the company to add.</p>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <ConnectToQuickBooksButton />
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-gray-500 hover:text-navy">
          Cancel
        </button>
      </div>
    </div>
  );
}
