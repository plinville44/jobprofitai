"use client";

import { useState } from "react";
import Image from "next/image";
import { DEMO_VIDEO, demoVideoEmbedUrl, type SiteVideo } from "@/lib/demoVideo";

/**
 * A demo video, loaded only when someone clicks play. The ad landing pages
 * show DEMO_VIDEO (the default); the partner page passes BOOKKEEPER_VIDEO.
 *
 * Until then it's our own still picture and a play button: no request goes to
 * YouTube, the page stays fast, and the Privacy Policy's "Videos" section
 * stays true. The click swaps in YouTube's privacy-enhanced player
 * (youtube-nocookie.com), which starts playing straight away.
 */
export default function DemoVideo({ video = DEMO_VIDEO }: { video?: SiteVideo }) {
  const [playing, setPlaying] = useState(false);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-jp-line bg-jp-ink shadow-[0_18px_40px_-24px_rgba(15,31,75,0.35)]">
      {playing ? (
        <iframe
          src={demoVideoEmbedUrl(video.youtubeId)}
          title={video.title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="absolute inset-0 h-full w-full"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`Play the demo video (${video.length})`}
          className="group absolute inset-0 h-full w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-jp-blue"
        >
          <Image src={video.poster} alt="" fill sizes="(min-width: 1024px) 896px, 100vw" className="object-cover" />
          <span className="absolute inset-0 flex items-center justify-center bg-jp-ink/10 transition group-hover:bg-jp-ink/20">
            {/* Smaller on phones, so it stays clear of the poster's headline. */}
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-jp-blue text-white shadow-lg transition group-hover:scale-105 sm:h-20 sm:w-20">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="ml-0.5 h-6 w-6 fill-current sm:ml-1 sm:h-9 sm:w-9">
                <path d="M8 5.5v13l10.5-6.5z" />
              </svg>
            </span>
          </span>
          <span className="absolute bottom-3 left-3 rounded-md bg-jp-ink/75 px-2.5 py-1 text-xs font-semibold text-white">
            Watch the demo &middot; {video.length}
          </span>
        </button>
      )}
    </div>
  );
}
