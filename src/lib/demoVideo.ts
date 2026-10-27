/**
 * Our videos. DEMO_VIDEO plays on the ad landing pages and BOOKKEEPER_VIDEO
 * on the partner page, both through src/components/marketing/DemoVideo.tsx;
 * GETTING_STARTED_VIDEO, below, is linked from the trial emails.
 *
 * Hosted on YouTube (unlisted) and played in YouTube's privacy-enhanced
 * mode, from youtube-nocookie.com. The page shows our own still picture
 * (public/demo-video-poster.jpg) until someone clicks play, so nothing is
 * loaded from YouTube before then. The Privacy Policy's "Videos" section
 * says exactly this; change both together.
 *
 * The videos show the labelled sample company, Example Builders, with its
 * figures from src/lib/sampleCompany.ts. The bookkeeper video's portfolio
 * page adds four more made-up client companies beside it.
 */
export interface SiteVideo {
  youtubeId: string;
  title: string;
  /** Shown on the play button. */
  length: string;
  /** Our own still picture in public/, shown until someone clicks play. */
  poster: string;
}

export const DEMO_VIDEO: SiteVideo = {
  youtubeId: "WUFhwPolxaI",
  title: "JobProfitAI demo: what to change on your jobs, and what it's worth",
  length: "2 min",
  poster: "/demo-video-poster.jpg",
};

/**
 * The 4-minute version for bookkeepers and accountants: the portfolio page,
 * client view-only logins, the WIP report, the cleanup list, the Firm price
 * and the partner commission. On the partner page, and linked from the Firm
 * plan on the pricing page. It is also the partner demo link in outreach.
 */
export const BOOKKEEPER_VIDEO: SiteVideo = {
  youtubeId: "NISEzBwD5xY",
  title: "JobProfitAI for bookkeepers and accountants",
  length: "4 min",
  poster: "/bookkeeper-video-poster.jpg",
};

/**
 * The player address. enablejsapi=1 lets Google Analytics' enhanced
 * measurement count plays where our tags are allowed to run; rel=0 keeps
 * the suggestions at the end to our own channel.
 */
export function demoVideoEmbedUrl(id: string = DEMO_VIDEO.youtubeId): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1&enablejsapi=1`;
}

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
