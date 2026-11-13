import { FIXTURES } from "../src/fixtures.ts";
import { BillingEmail, type BillingProps } from "../src/templates/billing.tsx";

/** The `billing-payment-no-invoice` fixture, for `bun run preview` (written by scripts/previews.ts). */
export default function Preview(props: BillingProps) {
  return <BillingEmail {...props} />;
}
Preview.PreviewProps = FIXTURES["billing-payment-no-invoice"]!.props as BillingProps;
