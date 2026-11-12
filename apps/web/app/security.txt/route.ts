import { securityTxt } from "@/components/security-txt";

// Made again once a day, so its Expires keeps moving forward (components/security-txt.ts).
export const revalidate = 86400;

export function GET() {
  return new Response(securityTxt(new Date()), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
