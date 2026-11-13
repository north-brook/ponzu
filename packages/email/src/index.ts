/*
 * @ponzu/email: Ponzu's emails as React Email templates (the email plan). Only @ponzu/api
 * depends on it. It never imports @ponzu/canvas, @ponzu/render, @ponzu/server, @ponzu/db or
 * resend, and apps/mobile never imports it (surface.test.ts).
 */
export { COMPANY, COMPANY_LINE, SITE_URL } from "./brand.ts";
export { type EmailKind, type EmailProps, type RenderedEmail, renderEmail } from "./render.ts";
export type { BillingProps } from "./templates/billing.tsx";
export type { DigestGroup, DigestLine, DigestProps } from "./templates/digest.tsx";
export type { MembersProps } from "./templates/members.tsx";
export type { NoticeProps } from "./templates/notice.tsx";
export type { RecapCanvas, RecapProps } from "./templates/recap.tsx";
export { clip, nameOf, oneLine } from "./text.ts";
export {
  SUSPENSION_REASON_MAX,
  type UnsubscribeCategory,
  unsubscribeWords,
} from "./words.ts";
