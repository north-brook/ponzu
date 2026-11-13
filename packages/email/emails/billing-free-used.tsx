import { FIXTURES } from "../src/fixtures.ts";
import { BillingEmail, type BillingProps } from "../src/templates/billing.tsx";

/** The `billing-free-used` fixture, for `bun run preview` (written by scripts/previews.ts). */
export default function Preview(props: BillingProps) {
  return <BillingEmail {...props} />;
}
Preview.PreviewProps = FIXTURES["billing-free-used"]!.props as BillingProps;
