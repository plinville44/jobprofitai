import { NextRequest, NextResponse } from "next/server";
import { shortLinkTarget } from "@/lib/shortLinks";

/**
 * GET /go/[slug]
 *
 * Short links for outreach emails (e.g. jobprofitai.com/go/demo). Forwards to
 * the tagged page listed in src/lib/shortLinks.ts with a temporary (307)
 * redirect, so a link can be pointed somewhere else later without browsers
 * remembering the old target. Always a path on this site; an unknown slug
 * goes to the homepage.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  // Next.js 16: route segment params arrive as a Promise.
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  return NextResponse.redirect(new URL(shortLinkTarget(slug), req.url), 307);
}
