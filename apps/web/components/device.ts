import type { Os } from "./platforms";

/**
 * Marks the visitor's device on `<html>` before the first paint, so pages stay static and nothing
 * flashes:
 *
 * - Phones and tablets get `data-device="phone"` and `data-phone` ("iphone", "ipad" or "android").
 *   Ponzu doesn't run there, so their Download buttons hand the download off to a computer
 *   (components/handoff.tsx). iPadOS reports itself as a Mac; touch points give it away.
 * - Computers get `data-os`: "mac", "windows", "linux", or "other" (ChromeOS, anything unknown).
 *
 * `.phone-only`, `.desktop-only` and the `.os-*` classes in globals.css show each its own parts.
 * Without the script (or on a phone) pages read as the Mac's.
 */
export const DEVICE_SCRIPT = `(function(){try{var n=navigator,d=document.documentElement,u=n.userAgent||"",t=n.maxTouchPoints>1,k=/iPhone|iPod/.test(u)?"iphone":/iPad/.test(u)||(/Macintosh/.test(u)&&t)?"ipad":/Android/i.test(u)?"android":"";if(k){d.dataset.device="phone";d.dataset.phone=k;return}var p=((n.userAgentData&&n.userAgentData.platform)||n.platform||"")+" "+u;d.dataset.os=/CrOS|Chrome OS/i.test(p)?"other":/Win/i.test(p)?"windows":/Mac/i.test(p)?"mac":/Linux|X11/i.test(p)?"linux":"other"}catch(e){}})()`;

export type Phone = "iphone" | "ipad" | "android";

/** The phone or tablet this page is on, as the script above marked it; null on a computer. */
export function phone(): Phone | null {
  if (typeof document === "undefined") return null;
  return (document.documentElement.dataset.phone as Phone | undefined) ?? null;
}

/** The computer this page is on; null on a phone, or one Ponzu doesn't ship for. */
export function desktop(): Os | null {
  if (typeof document === "undefined") return null;
  const os = document.documentElement.dataset.os;
  return os === "mac" || os === "windows" || os === "linux" ? os : null;
}
