/**
 * Marks phones and tablets on `<html>` before the first paint: `data-device="phone"` and
 * `data-phone` ("iphone", "ipad" or "android"). Ponzu doesn't run there, so their Download buttons
 * hand the download off to a computer (components/handoff.tsx) and `.phone-only` and
 * `.desktop-only` in globals.css swap what each sees, with no flash and a page that stays static.
 * iPadOS reports itself as a Mac; touch points give it away.
 */
export const DEVICE_SCRIPT = `(function(){try{var n=navigator,u=n.userAgent||"",t=n.maxTouchPoints>1,k=/iPhone|iPod/.test(u)?"iphone":/iPad/.test(u)||(/Macintosh/.test(u)&&t)?"ipad":/Android/i.test(u)?"android":"";if(k){var d=document.documentElement;d.dataset.device="phone";d.dataset.phone=k}}catch(e){}})()`;

export type Phone = "iphone" | "ipad" | "android";

/** The phone or tablet this page is on, as the script above marked it; null on a computer. */
export function phone(): Phone | null {
  if (typeof document === "undefined") return null;
  return (document.documentElement.dataset.phone as Phone | undefined) ?? null;
}
