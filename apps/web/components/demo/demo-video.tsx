"use client";

import { useEffect, useRef, useState } from "react";
import { useSystemTheme } from "./theme";
import VIDEOS from "./videos.json";

/** A recording of one story in one color scheme, hosted on Vercel Blob (scripts/record-demo.ts). */
export interface DemoRecording {
  src: string;
  /** The story's last frame, finished: what it shows with reduced motion, and until it plays. */
  poster: string;
  width: number;
  height: number;
  ms: number;
  bytes: number;
}

const RECORDINGS: Record<string, Record<"light" | "dark", DemoRecording>> = VIDEOS;

/**
 * The demo on a phone or tablet: the live demo recorded playing its story in the narrow layout, in
 * the page's color scheme. It loads once it's near the screen and plays only while it's on it. With
 * reduced motion it's the finished story, still, as the live demo shows it.
 */
export function DemoVideo({ story, label }: { story: string; label: string }) {
  const scheme = useSystemTheme();
  const recording = RECORDINGS[story]?.[scheme];
  const video = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  // Only ever rendered in the browser (ProductDemo), so this can read the query as it mounts.
  const [still] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setNear(true);
      },
      { rootMargin: "50% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = video.current;
    if (!el || !near || still || !recording) return;
    // iOS only autoplays muted video, and React sets `muted` as a property it may not have yet.
    el.muted = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) el.play().catch(() => {});
      else el.pause();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, still, recording]);

  return (
    <div role="img" aria-label={label} className="dm-frame relative w-full" data-video="">
      <video
        ref={video}
        className="absolute inset-0 size-full"
        width={recording?.width}
        height={recording?.height}
        poster={near ? recording?.poster : undefined}
        src={near && !still ? recording?.src : undefined}
        muted
        playsInline
        loop
        autoPlay={!still}
        preload="metadata"
      />
    </div>
  );
}
