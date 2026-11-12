import type { CardBrand as Brand } from "./billing.ts";

const VISA =
  "M9.112 8.262L5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 01.894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 011.913.336l.34-1.59a5.207 5.207 0 00-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.992-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.377-2.564m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 00-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656l1.02-2.815.588 2.815zm-8.16-4.84l-1.603 7.496H8.34l1.605-7.496z";

/**
 * A card's brand on a small white badge, white in either theme as a card is: Visa's wordmark,
 * Mastercard's two circles, Amex's blue box. Visa is Simple Icons' (CC0).
 */
export function CardBrand({ brand }: { brand: Brand }) {
  return (
    <span
      aria-hidden
      className="grid h-[21px] w-8 shrink-0 place-items-center rounded-4 shadow-[inset_0_0_0_1px_var(--c-rule)]"
      style={{ background: "#ffffff" }}
    >
      {brand === "visa" ? (
        <svg aria-hidden width={26} height={26} viewBox="0 0 24 24">
          <path fill="#1a1f71" d={VISA} />
        </svg>
      ) : brand === "mastercard" ? (
        <svg aria-hidden width={20} height={13} viewBox="0 0 20 13">
          <circle cx="6.5" cy="6.5" r="6.5" fill="#eb001b" />
          <circle cx="13.5" cy="6.5" r="6.5" fill="#f79e1b" />
          <path d="M10 1.05a6.5 6.5 0 0 1 0 10.9 6.5 6.5 0 0 1 0-10.9Z" fill="#ff5f00" />
        </svg>
      ) : brand === "amex" ? (
        <svg aria-hidden width={24} height={15} viewBox="0 0 24 15">
          <rect width="24" height="15" rx="2" fill="#2e77bc" />
          <text
            x="12"
            y="10.4"
            textAnchor="middle"
            fill="#ffffff"
            fontFamily="Inter, system-ui, sans-serif"
            fontSize="7"
            fontWeight="700"
          >
            AMEX
          </text>
        </svg>
      ) : (
        <span className="h-1.5 w-4 rounded-2 bg-faint" />
      )}
    </span>
  );
}
