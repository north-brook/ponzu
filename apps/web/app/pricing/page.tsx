import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer, Nav } from "@/components/chrome";
import { count, dollars, EXAMPLES, PRICES, pastDefaultCap } from "@/components/pricing";
import { share } from "@/components/share";
import { BILLING_LIVE, CONTACT } from "@/components/site";

const TITLE = "Pricing";
const DESCRIPTION = `Pay as you go: ${PRICES.credit} a credit, ${PRICES.creditsPerHour} credits an awake hour, and ${PRICES.freeCredits} free credits a month for each person. Your own Claude plan runs the model.`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  ...share({ path: "/pricing", title: `${TITLE} · Ponzu`, description: DESCRIPTION }),
};

/*
 * One plan, Pay as you go, on the published rate card. Every number on this page comes from
 * components/pricing.ts, which reads packages/db's rate-card.ts; pricing.test.ts fails on a
 * dollar amount typed in here. What happens at the cap is billing's gate: no new turn starts until
 * an admin raises the cap or the month resets, and a running turn finishes.
 */

const HOW_IT_WORKS: readonly ReactNode[] = [
  `A canvas is awake while Ponzu works on it, and sleeps ${PRICES.sleepMinutes} minutes after the last activity. Asleep costs nothing.`,
  "Opening a canvas to look never wakes it.",
  `Each workspace has a monthly cap, ${PRICES.cap} to start, and is never charged past it. At the cap, no new turn starts in the workspace until an admin raises the cap or the month resets. A turn that's running finishes.`,
  "Claude runs on your plan: a Claude Pro or Max subscription, or an Anthropic API key. Ponzu adds nothing for tokens.",
];

const FAQ: readonly { q: string; a: ReactNode }[] = [
  {
    q: "What counts as awake?",
    a: "From the moment a canvas wakes until it goes back to sleep, measured to the second. A partial credit is never charged.",
  },
  {
    q: "Do credits roll over?",
    a: "No. The free credits reset each month, on the day of the month the workspace was made.",
  },
  {
    q: "Is the iPhone app extra?",
    a: "No. Billing lives on the Mac.",
  },
  {
    q: "What happens at the cap?",
    a: `No new turn starts in the workspace until an admin raises the cap or the month resets. A turn that's running finishes.`,
  },
  {
    q: "Who counts for free credits?",
    a: "Everyone who has signed in to Ponzu and was in the workspace that month.",
  },
];

export default function Page() {
  const team = EXAMPLES.at(-1)!.cost;
  return (
    <div className="mx-auto max-w-[1440px] px-16 max-[720px]:px-5">
      <Nav />

      <header className="flex flex-col items-center gap-6 pt-[88px] pb-14 text-center max-[720px]:pt-14 max-[720px]:pb-10">
        <h1 className="m-0 text-[clamp(44px,6vw,72px)] leading-[1.06] font-semibold tracking-[-0.035em] text-balance text-ink">
          Pay for what runs.
        </h1>
        <p className="m-0 max-w-[620px] text-[19px]/[31px] text-balance text-muted">
          Everyone gets everything: the Mac and iPhone apps, unlimited canvases, teams. Your own
          Claude plan runs the model; Ponzu charges only while a canvas&apos;s sandbox is awake.
        </p>
      </header>

      <div className="mx-auto flex max-w-[1000px] flex-col gap-16 max-[720px]:gap-12">
        {BILLING_LIVE ? null : (
          <p
            data-billing="not-live"
            className="m-0 rounded-2xl bg-chip px-6 py-4 text-center text-[15px]/[24px] text-pretty text-ink shadow-[inset_0_0_0_1px_var(--rule)]"
          >
            Ponzu is free while billing is being set up. These are the prices when it starts, and
            we&apos;ll tell you before it does.
          </p>
        )}

        <section aria-label="The prices" className="grid grid-cols-3 gap-5 max-[820px]:grid-cols-1">
          <Figure value={count(PRICES.freeCredits)} unit="free credits">
            a month, per person, pooled in a team
          </Figure>
          <Figure value={PRICES.credit} unit="">
            a credit
          </Figure>
          <Figure value={count(PRICES.creditsPerHour)} unit="credits">
            an awake hour ({PRICES.hour})
          </Figure>
        </section>

        <Part title="How it works">
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {HOW_IT_WORKS.map((line, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list that never reorders.
                key={i}
                className="flex gap-3 text-[16px]/[27px] text-pretty text-muted"
              >
                <span aria-hidden className="mt-[11px] size-1.5 shrink-0 rounded-full bg-yuzu" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Part>

        <Part title="What a month costs">
          <div className="overflow-x-auto rounded-3xl bg-tile px-5 py-2 sm:px-8">
            <table className="w-full border-collapse text-left text-[15px]/6 max-[480px]:text-[14px]/5">
              <thead>
                <tr className="text-faint">
                  <th className="py-4 pr-4 max-[480px]:pr-2 font-medium">
                    <span className="sr-only">Example</span>
                  </th>
                  <th className="py-4 pr-4 max-[480px]:pr-2 text-right font-medium">Awake time</th>
                  <th className="py-4 pr-4 max-[480px]:pr-2 text-right font-medium">Credits</th>
                  <th className="py-4 text-right font-medium">You pay</th>
                </tr>
              </thead>
              <tbody>
                {EXAMPLES.map(({ label, cost }) => (
                  <tr key={label} className="border-t border-rule">
                    <th scope="row" className="py-4 pr-4 max-[480px]:pr-2 font-medium text-ink">
                      {label}
                    </th>
                    <td className="py-4 pr-4 max-[480px]:pr-2 text-right text-muted tabular-nums">
                      {count(cost.hours)} h
                    </td>
                    <td className="py-4 pr-4 max-[480px]:pr-2 text-right text-muted tabular-nums">
                      {count(cost.credits)}
                    </td>
                    <td className="py-4 text-right font-semibold text-ink tabular-nums">
                      {dollars(cost.cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="m-0 text-[14px]/[22px] text-pretty text-faint">
            The team row assumes {count(team.people)} people, so {count(team.freeCredits)} credits
            are free.
            {pastDefaultCap(team)
              ? ` It also needs a cap above the ${PRICES.cap} a workspace starts with, which an admin sets in Settings.`
              : null}
          </p>
        </Part>

        <div className="grid grid-cols-2 gap-5 max-[820px]:grid-cols-1">
          <Card title="Teams">
            A team is a GitHub organization with Ponzu installed: one card, one cap and pooled free
            credits. A canvas bills to the workspace that owns its repo, so canvases on your
            personal repos bill to you. Admins see usage by person.
          </Card>
          <Card title="Enterprise">
            Need SSO, your own region or an invoice?{" "}
            <a
              className="text-ink underline decoration-outline underline-offset-4 hover:decoration-ink"
              href={`mailto:${CONTACT.hello}`}
            >
              Write to us.
            </a>
          </Card>
        </div>

        <Part title="Questions">
          <dl className="m-0 flex flex-col">
            {FAQ.map(({ q, a }) => (
              <div key={q} className="flex flex-col gap-1.5 border-t border-rule py-5">
                <dt className="text-[16px]/[26px] font-semibold text-ink">{q}</dt>
                <dd className="m-0 text-[16px]/[27px] text-pretty text-muted">{a}</dd>
              </div>
            ))}
          </dl>
        </Part>
      </div>

      <Footer />
    </div>
  );
}

function Figure({ value, unit, children }: { value: string; unit: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-3xl bg-tile p-8 max-[720px]:p-6">
      <span className="flex items-baseline gap-2">
        <span className="text-[56px]/[1] font-semibold tracking-[-0.04em] text-ink tabular-nums">
          {value}
        </span>
        {unit ? <span className="text-[17px] font-medium text-ink">{unit}</span> : null}
      </span>
      <span className="text-[15px]/[24px] text-muted">{children}</span>
    </div>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <h2 className="m-0 text-[28px]/[34px] font-semibold tracking-[-0.022em] text-ink max-[720px]:text-[24px]/[30px]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-3xl p-8 shadow-[inset_0_0_0_1px_var(--rule)] max-[720px]:p-6">
      <h2 className="m-0 text-[22px]/[30px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <p className="m-0 text-[16px]/[27px] text-pretty text-muted">{children}</p>
    </div>
  );
}
