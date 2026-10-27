import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BOOKKEEPER_VIDEO, DEMO_VIDEO } from "@/lib/demoVideo";

// The 4-minute bookkeeper video sits under the hero on the partner page, in
// the same click-to-play player as the ad landing pages, and the Firm plan on
// the pricing page links to it.

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const flat = (rel: string) => read(rel).replace(/\s+/g, " ");

describe("bookkeeper video", () => {
  it("is its own video, with its own picture on our site", () => {
    expect(BOOKKEEPER_VIDEO.youtubeId).toBe("NISEzBwD5xY");
    expect(BOOKKEEPER_VIDEO.youtubeId).not.toBe(DEMO_VIDEO.youtubeId);
    for (const video of [DEMO_VIDEO, BOOKKEEPER_VIDEO]) {
      expect({ poster: video.poster, exists: existsSync(join(SRC, "..", "public", video.poster)) }).toEqual({
        poster: video.poster,
        exists: true,
      });
    }
  });

  it("plays under the partner page's hero, before the commission section", () => {
    const page = flat("app/(marketing)/partners/page.tsx");
    expect(page).toContain("<DemoVideo video={BOOKKEEPER_VIDEO} />");
    expect(page).toContain('<div id="video" className="mx-auto max-w-4xl scroll-mt-24">');
    expect(page.indexOf("Apply to the Partner Program")).toBeLessThan(page.indexOf("<DemoVideo"));
    expect(page.indexOf("<DemoVideo")).toBeLessThan(page.indexOf('eyebrow="Commission"'));
  });

  it("uses the player that loads nothing from YouTube until play, for every video", () => {
    const player = flat("components/marketing/DemoVideo.tsx");
    expect(player).toContain("export default function DemoVideo({ video = DEMO_VIDEO }: { video?: SiteVideo })");
    expect(player).toContain("src={demoVideoEmbedUrl(video.youtubeId)}");
    expect(player).toContain("<Image src={video.poster}");
  });

  it("is linked from the Firm plan on the pricing page", () => {
    const pricing = flat("app/(marketing)/pricing/page.tsx");
    const firm = pricing.slice(pricing.indexOf('<Section id="firm">'), pricing.indexOf('<Section id="fit-check"'));
    expect(firm).toContain('href="/partners#video"');
    expect(firm).toContain("Watch the 4-minute video for bookkeepers");
  });

  it("follows the house style: no en or em dashes", () => {
    for (const file of ["app/(marketing)/partners/page.tsx", "app/(marketing)/pricing/page.tsx", "components/marketing/DemoVideo.tsx", "lib/demoVideo.ts"]) {
      expect({ file, dashes: /[\u2013\u2014]/.test(read(file)) }).toEqual({ file, dashes: false });
    }
  });
});
