import Image from "next/image";
import Link from "next/link";

/**
 * The JobProfitAI logo lockup. One component so the asset, dimensions and
 * alt text stay identical everywhere it appears.
 *
 * The intrinsic size ratio (2069x600 after trimming) is passed to next/image
 * so the browser reserves the right space before the image loads - otherwise
 * the header visibly jumps on every first paint.
 */
export function Logo({
  className = "",
  width = 190,
  priority = false,
}: {
  className?: string;
  width?: number;
  priority?: boolean;
}) {
  const height = Math.round((width * 600) / 2069);
  return (
    <Image
      src="/jobprofitai-logo.png"
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
export function LogoLink({ width = 190, priority = false }: { width?: number; priority?: boolean }) {
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
