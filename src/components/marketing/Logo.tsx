import Image from "next/image";
import Link from "next/link";

/**
 * The JobProfitAI logo. One component so the asset, dimensions and alt text
 * stay identical everywhere it appears.
 *
 * Two assets, deliberately:
 *
 * - jobprofitai-wordmark.png (1160x205) is the icon plus "JobProfitAI". This
 *   is what the site uses. In a header the whole lockup can only be about
 *   35px tall, and the tagline inside the full artwork renders at roughly
 *   3px at that size - present, unreadable, and it drags the wordmark itself
 *   smaller to make room. Cropping it out lets the name render about 20%
 *   larger in the same space.
 *
 * - jobprofitai-logo.png (1200x348) is the full lockup with the "Profit
 *   Intelligence for QuickBooks" tagline baked in. Reach for it only at sizes
 *   where the tagline is genuinely legible, roughly 400px wide and up: a
 *   print piece, a slide, an email header. Not navigation.
 *
 * On the web the tagline belongs in real text next to the mark, where it is
 * selectable, translatable and readable at any size. The footer already does
 * this.
 *
 * Intrinsic dimensions are passed to next/image so the browser reserves the
 * right space before the image loads, otherwise the header visibly jumps on
 * first paint.
 */

const WORDMARK = { src: "/jobprofitai-wordmark.png", w: 1160, h: 205 };
const LOCKUP = { src: "/jobprofitai-logo.png", w: 1200, h: 348 };

export function Logo({
  className = "",
  width = 200,
  priority = false,
  withTagline = false,
}: {
  className?: string;
  width?: number;
  priority?: boolean;
  /** Full lockup including the tagline. Only legible at ~400px wide and up. */
  withTagline?: boolean;
}) {
  const art = withTagline ? LOCKUP : WORDMARK;
  const height = Math.round((width * art.h) / art.w);
  return (
    <Image
      src={art.src}
      alt="JobProfitAI"
      width={width}
      height={height}
      priority={priority}
      className={className}
      sizes={`${width}px`}
    />
  );
}

/** Logo wrapped in a link home, for headers and footers. */
export function LogoLink({ width = 200, priority = false }: { width?: number; priority?: boolean }) {
  return (
    <Link href="/" className="inline-flex items-center" aria-label="JobProfitAI home">
      <Logo width={width} priority={priority} />
    </Link>
  );
}

/** Square mark only - used where the full lockup is too wide. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <Image
      src="/jobprofitai-mark.png"
      alt=""
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    />
  );
}
