"use client";

import { useEffect, useRef, useState } from "react";
import { useSystemTheme } from "./theme";
import VIDEOS from "./videos.json";

/** A recording of one story in one color scheme, hosted on Vercel Blob (scripts/record-demo.ts). */
export interface DemoRecording {
  src: string;
  /** Its first frame, shown until it plays, so the video takes over without a jump. */
  poster: string;
  /** Its last frame, the story finished: what reduced motion shows. */
  still: string;
  width: number;
  height: number;
  ms: number;
  bytes: number;
}

const RECORDINGS: Record<string, Record<"light" | "dark", DemoRecording>> = VIDEOS;

/**
 * The demo on a phone or tablet: the live demo recorded playing one story in the narrow layout, in
 * the page's color scheme. It loads once it's near the screen and plays only while it's on it. With
 * reduced motion it's the finished story, still, as the live demo shows it. Given `onEnded` it plays
 * once rather than looping, reporting how far through it is as it goes.
 */
export function DemoVideo({
  id,
  story,
  label,
  onProgress,
  onEnded,
}: {
  id?: string;
  story: string;
  label: string;
  /** How far through the story the video is, from 0 to 1, every frame while it plays. */
  onProgress?: (progress: number) => void;
  onEnded?: () => void;
}) {
  const scheme = useSystemTheme();
  const recording = RECORDINGS[story]?.[scheme];
  const video = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  // Only ever rendered in the browser (ProductDemo), so this can read the query as it mounts.
  const [still] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const report = useRef(onProgress);
  report.current = onProgress;

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

  // The tab's rule follows the video smoothly, not at `timeupdate`'s few times a second.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (el.duration) report.current?.(el.currentTime / el.duration);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const stop = () => cancelAnimationFrame(frame);
    el.addEventListener("playing", start);
    el.addEventListener("pause", stop);
    el.addEventListener("ended", stop);
    return () => {
      stop();
      el.removeEventListener("playing", start);
      el.removeEventListener("pause", stop);
      el.removeEventListener("ended", stop);
    };
  }, []);

  return (
    <div id={id} role="img" aria-label={label} className="dm-frame relative w-full" data-video="">
      <video
        ref={video}
        className="absolute inset-0 size-full"
        width={recording?.width}
        height={recording?.height}
        poster={near ? (still ? recording?.still : recording?.poster) : undefined}
        src={near && !still ? recording?.src : undefined}
        muted
        playsInline
        loop={!onEnded}
        onEnded={onEnded}
        autoPlay={!still}
        preload="metadata"
      />
    </div>
  );
}
