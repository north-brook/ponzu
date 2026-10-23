import { Image, type ImageStyle } from "expo-image";
import { useEffect, useState } from "react";
import type { StyleProp } from "react-native";
import { cachedImage, cacheImage } from "../lib/cache";
import { USER_AGENT } from "../lib/ua";

/**
 * An image from a Mac: the cached copy at once if there is one, and the Mac's
 * own when it answers, saved for next time. A Mac that's asleep still shows
 * the last copy.
 */
export function MacImage({
  mac,
  url,
  live,
  style,
  contentFit = "cover",
  contentPosition = "top",
  onSize,
}: {
  mac: string;
  url: string | null;
  live: boolean;
  style?: StyleProp<ImageStyle>;
  contentFit?: "cover" | "contain";
  contentPosition?: "top" | "center";
  /** The image's own size in pixels, once it's loaded. */
  onSize?: (width: number, height: number) => void;
}) {
  const [uri, setUri] = useState<string | null>(() => (url ? cachedImage(mac, url) : null));
  useEffect(() => {
    if (!url) return setUri(null);
    const cached = cachedImage(mac, url);
    setUri(cached);
    if (cached || !live) return;
    let on = true;
    cacheImage(mac, url).then((u) => on && u && setUri(u));
    return () => {
      on = false;
    };
  }, [mac, url, live]);
  const source = uri
    ? { uri }
    : url && live
      ? { uri: url, headers: { "User-Agent": USER_AGENT } }
      : null;
  if (!source) return null;
  return (
    <Image
      source={source}
      style={style}
      contentFit={contentFit}
      contentPosition={contentPosition}
      transition={150}
      cachePolicy="memory"
      onLoad={onSize ? (e) => onSize(e.source.width, e.source.height) : undefined}
    />
  );
}
