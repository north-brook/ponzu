import { FIXTURES } from "../src/fixtures.ts";
import { BillingEmail, type BillingProps } from "../src/templates/billing.tsx";

/** The `billing-payment-failed` fixture, for `bun run preview` (written by scripts/previews.ts). */
export default function Preview(props: BillingProps) {
  return <BillingEmail {...props} />;
}
Preview.PreviewProps = FIXTURES["billing-payment-failed"]!.props as BillingProps;
