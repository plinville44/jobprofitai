/**
 * Our videos. DEMO_VIDEO plays on the ad landing pages and BOOKKEEPER_VIDEO
 * on the partner page, both through src/components/marketing/DemoVideo.tsx.
 *
 * On our website they play from our own files: 1080p MP4s in our public
 * Vercel Blob store, so they're always sharp (YouTube picks a low quality
 * for a player this size and can't be told otherwise). Nothing on our
 * website loads from YouTube. The Privacy Policy's "Videos" section says
 * exactly this; change both together.
 *
 * The same videos are on YouTube (unlisted) for links in emails and
 * outreach. GETTING_STARTED_VIDEO, below, is linked from the trial emails.
 *
 * The videos show the labelled sample company, Example Builders, with its
 * figures from src/lib/sampleCompany.ts. The bookkeeper video's portfolio
 * page adds four more made-up client companies beside it.
 */
export interface SiteVideo {
  /** The MP4 (H.264, 1080p) in our public Vercel Blob store. */
  src: string;
  /** The same video on YouTube, for links in emails and outreach. */
  youtubeId: string;
  title: string;
  /** Shown on the play button. */
  length: string;
  /** Our own still picture in public/, shown until someone clicks play. */
  poster: string;
}

export const DEMO_VIDEO: SiteVideo = {
  src: "https://ysywlv60mtve3piz.public.blob.vercel-storage.com/jobprofitai-demo.mp4",
  youtubeId: "WUFhwPolxaI",
  title: "JobProfitAI demo: what to change on your jobs, and what it's worth",
  length: "2 min",
  poster: "/demo-video-poster.jpg",
};

/**
 * The 4-minute version for bookkeepers and accountants: the portfolio page,
 * client view-only logins, the WIP report, the cleanup list, the Firm price
 * and the partner commission. On the partner page, and linked from the Firm
 * plan on the pricing page. Its YouTube link is the partner demo link in
 * outreach.
 */
export const BOOKKEEPER_VIDEO: SiteVideo = {
  src: "https://ysywlv60mtve3piz.public.blob.vercel-storage.com/jobprofitai-for-bookkeepers.mp4",
  youtubeId: "NISEzBwD5xY",
  title: "JobProfitAI for bookkeepers and accountants",
  length: "4 min",
  poster: "/bookkeeper-video-poster.jpg",
};

/**
 * The 1-minute getting-started video: connecting QuickBooks, the first
 * report, and the three things to set. Unlisted on YouTube and linked (not
 * embedded) from the welcome and setup reminder emails, so it opens on
 * YouTube's own site.
 */
export const GETTING_STARTED_VIDEO = {
  youtubeId: "dNrl-P3mNhI",
  title: "Getting started with JobProfitAI",
  length: "1 min",
} as const;

/** A video's own page on YouTube, for links in emails. */
export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}
