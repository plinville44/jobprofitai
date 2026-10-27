"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { DEMO_VIDEO, type SiteVideo } from "@/lib/demoVideo";

/**
 * Tells Google Tag Manager that a video started or finished. Only where our
 * tags are running: the loader (src/lib/tracking.ts) is what creates
 * window.dataLayer, so after an opt-out or a Global Privacy Control signal
 * there is nothing to push to and nothing is sent.
 */
function videoEvent(event: "video_start" | "video_complete", video: SiteVideo) {
  const layer = (window as { dataLayer?: unknown[] }).dataLayer;
  if (Array.isArray(layer)) layer.push({ event, video_title: video.title, video_provider: "jobprofitai" });
}

/**
 * A demo video, played from our own 1080p file. The ad landing pages show
 * DEMO_VIDEO (the default); the partner page passes BOOKKEEPER_VIDEO.
 *
 * Until someone clicks play it's our still picture and a play button, and
 * preload="none" means the file isn't downloaded until then. The click
 * starts the video with sound and shows the browser's own controls.
 */
export default function DemoVideo({ video = DEMO_VIDEO }: { video?: SiteVideo }) {
  const [playing, setPlaying] = useState(false);
  const player = useRef<HTMLVideoElement>(null);
  const started = useRef(false);

  function play() {
    setPlaying(true);
    // Inside the click itself, so browsers (Safari on iPhone included) let it play with sound.
    const attempt = player.current?.play();
    // If the browser refuses or the file can't load, show the picture and button again.
    if (attempt) attempt.catch(() => setPlaying(false));
  }

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-jp-line bg-jp-ink shadow-[0_18px_40px_-24px_rgba(15,31,75,0.35)]">
      <video
        ref={player}
        src={video.src}
        preload="none"
        playsInline
        controls={playing}
        aria-label={video.title}
        onPlay={() => {
          if (started.current) return;
          started.current = true;
          videoEvent("video_start", video);
        }}
        onEnded={() => videoEvent("video_complete", video)}
        className="absolute inset-0 h-full w-full"
      />
      {!playing && (
        <button
          type="button"
          onClick={play}
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
