import type { Example } from "@ponzu/evals";
import type { ThreadCriterion, ThreadTurn } from "./judge.ts";

/*
 * What the thread judge must get right. The real turns are verbatim from the hand-run
 * measurements of pull requests #448 (cloud-agent-voice: five situations, before and after) and
 * #451 (cloud-thread-links: five turns with links), with the facts their harness recorded; the
 * rest are made up to pin one criterion each. Each example labels only the criteria it is about.
 */

type Labels = Partial<Record<ThreadCriterion, "pass" | "fail" | "n/a">>;
export type ThreadExample = Example<ThreadTurn, Labels>;

const ONBOARDING =
  "Message from Ada: Design the onboarding flow for the fitness app in this repo, as iPhone screens.";
const GOAL =
  'Comment from Ada, pinned on "2 Goal": "This should be one goal only, and make the options bigger."';
const NOTIFICATIONS = "Message from Ada: Why do you ask for notifications after the questions?";
const PAYWALL = "Message from Ada: Where should the paywall go? Lay out the options.";
const GREEN =
  'Comment from Ada on the canvas: "Make the accent a deep green instead of orange, everywhere."';
const FLOW_FACTS =
  "Made 7 iPhone screen boards on the Onboarding page and a board named 'Note: How the flow works'. Committed a spec and screenshots under docs/onboarding/ and pushed pz/fitness-onboarding. describe_pull_request was called. No pull request is open. Nothing failed.";
const LINK = "https://ponzu.design/designs/des_q4f8k2trial";

export const THREAD_JUDGE_EXAMPLES: ThreadExample[] = [
  {
    id: "448-s1-before",
    note: "Seven progress lines, then an 1,841-character recap with a bullet per screen and headings.",
    input: {
      request: ONBOARDING,
      facts: FLOW_FACTS,
      midTurn: [
        'Setting up the Cadence look (warm paper, ink, signal-orange accent, a "rhythm bars" motif) and building screen 1 Welcome; checking it now.',
        "Screens 1 Welcome and 2 Goal are done; now building 3 Experience from the same question template.",
        "Screens 3 Experience and 4 Schedule are built. Next I'm loosening the day chips on 4 Schedule, then building Apple Health and the plan screens.",
        'Building screen 6, the "building your plan" moment, on a dark ink background with animated rhythm bars.',
        "Screen 6 Building plan animates cleanly. Now the last one, 7 Plan ready.",
        "All seven screens are built. Now I'm adding a note board that explains the flow, then committing a short spec with exported screens to the branch.",
        "Exporting the screens into the repo with a short spec, then committing and pushing.",
      ],
      closing: `I've designed the onboarding flow for **Cadence** (the app name from the repo's README). It's on the **Onboarding** page as seven iPhone screens, left to right:

1. **Welcome**: "Train to your own rhythm.", a "Get started" button and a sign-in link.
2. **Goal**: get stronger, build endurance, lose weight or feel better. You pick one.
3. **Experience**: four levels from brand new to experienced, each shown with a small bar meter. This sets how hard week 1 is.
4. **Schedule**: you pick the actual training days, not just a count, plus 20, 30, 45 or 60 minutes per session.
5. **Apple Health**: the only optional step. It explains what the app reads and writes before the system permission sheet appears.
6. **Building plan**: a dark transition of about 2 seconds with animated bars that repeats your answers back.
7. **Plan ready**: week 1 on real dates. It ends on "Start today's workout" rather than a dashboard.

**The look:** warm off-white background, near-black text and one signal-orange accent, kept for the main button. Selected options are filled black instead of orange. The type is Inter Tight. A set of vertical "rhythm bars" recurs on screens 1, 3, 6 and 7. The colors and type are saved as design tokens and the brief as a design note. A note board under the screens explains the reasoning for each step.

**In the repo:** I committed \`docs/onboarding/README.md\` (the flow, the rules and the tokens) and images of all seven screens, pushed the \`pz/fitness-onboarding\` branch, and wrote the pull request description. No app code is in the repo yet, so this is a design spec for now.

A few things you may want to change:
- **Account creation** comes after the first workout, not up front.
- **Equipment** (home or gym) isn't asked. It could be a fifth question.
- **Dark mode**: the screens have a single light look for now.`,
      prDescription: null,
    },
    expect: { closing: "fail", mid_turn: "fail", failures: "pass" },
  },
  {
    id: "448-s1-final",
    note: "Five progress lines (still narration), then a 500-character close that points at the note and asks the one question.",
    input: {
      request: ONBOARDING,
      facts: FLOW_FACTS,
      midTurn: [
        "Setting up the Cadence look and building the welcome screen now; the rest of the flow follows left to right.",
        'Welcome and Goal screens are done; now filling in Experience, Schedule, Apple Health and Reminders, then a final "your plan" screen.',
        "Progress, step labels and headings across all four first.",
        "Schedule and Apple Health are in; tidying copy, then Reminders and the final plan screen.",
        'Last screen ("7 Your plan") is in; checking it, then adding a short note beside the flow.',
      ],
      closing:
        'I\'ve designed a seven-screen onboarding flow for Cadence. It\'s on the Onboarding page, from "1 Welcome" to "7 Your plan", and the "Note: How the flow works" board below it explains the main choices. There\'s no account creation screen yet; the flow assumes sign-up comes after people see their plan, and that order is the first thing I\'d like you to confirm. The repo has no UI code yet, so I committed a spec and screenshots under `docs/onboarding/` and pushed the branch, ready for the pull request.',
      prDescription: null,
    },
    expect: { closing: "pass", mid_turn: "fail", failures: "pass" },
  },
  {
    id: "448-s1-first-after",
    note: "A close that summarises the five questions in one sentence to orient the person, and states the decision needed.",
    hard: true,
    input: {
      request: ONBOARDING,
      facts: FLOW_FACTS,
      midTurn: [
        "Welcome screen's done — dark, with the rhythm bars as the brand motif. Now building the question screens (goal, experience, schedule, equipment, reminders) and a plan reveal at the end.",
        "Experience screen is in; now the schedule, equipment and reminder screens.",
        "Plan reveal is done (screen 7). Adding a short note on the flow and open questions, then exporting the screens into the repo.",
      ],
      closing: `I've designed the Cadence onboarding as seven iPhone screens on the Onboarding page, left to right. It opens on a welcome screen, asks five quick questions (goal, experience, training days, equipment, reminders), and ends on a screen that shows the plan built from the answers.

I didn't include account sign-up. My suggestion is to put it after the plan screen, so people see what they get before they sign up. That question and two smaller ones (Apple Health access, and whether weight loss needs age and weight) are on the note below the screens.

I also exported the screens and wrote a short spec in \`docs/onboarding/\`. That's committed and pushed to \`pz/fitness-onboarding\`, and the pull request description is ready.`,
      prDescription: null,
    },
    expect: { closing: "pass", mid_turn: "fail" },
  },
  {
    id: "448-s2-before",
    note: "A 1,028-character close with a bullet per change and pixel sizes; a progress line before it.",
    input: {
      request: GOAL,
      facts:
        "Changed the board '2 Goal': round single-choice markers, rows 96px instead of 76px, bigger icons and type, subtitle now starts 'Pick one'. Committed and pushed. The comment's thread was not on the canvas (a harness fault), so it could not be resolved. Nothing else failed.",
      midTurn: [
        "The screen fits with room to spare above Continue. Updating the export, spec and brief, then pushing.",
      ],
      closing: `I've updated **2 Goal** so it's clearly one goal, with bigger options.

- **One goal only:** the screen already allowed just one choice, but its checkmark-in-a-circle looked like a checkbox where you could tick several. Each option now has a round radio button that shows a filled dot when selected. Picking one clears the others, and the subtitle starts with "Pick one".
- **Bigger options:** each row is now 96px tall instead of 76px. Icon tiles went from 44px to 56px, titles from 17px to 19px, and descriptions from 14px to 15px. All four rows still fit above Continue.

I re-exported the screen, added the single-choice rule to \`docs/onboarding/README.md\`, pushed the branch and updated the pull request description.

I couldn't find your comment thread on 2 Goal, so it's still open. Please resolve it on your side.

Decision for you: **3 Experience** is also one choice, but it still has the old smaller rows with checkmarks, so it now looks different from 2 Goal. Should I give it the same radio buttons and bigger rows?`,
      prDescription: null,
    },
    expect: { closing: "fail", mid_turn: "fail" },
  },
  {
    id: "448-s2-after",
    note: "Short, but it describes the asked change back to the person who can see it.",
    hard: true,
    input: {
      request: GOAL,
      facts:
        "Changed the board '2 Goal': single-choice markers, bigger rows, a new subtitle, one shortened description. Committed and pushed. Nothing failed.",
      midTurn: [],
      closing: `On "2 Goal", people can now pick only one goal. The options are bigger, each has a round single-choice marker, and the chosen one turns dark. The subtitle now says "Choose one to focus on", and I shortened "Run farther"'s description to "Endurance, or a race" so it fits on one line.

I updated the exported screen and spec in \`docs/onboarding/\`, then committed and pushed to \`pz/fitness-onboarding\`.`,
      prDescription: null,
    },
    expect: { closing: "fail", mid_turn: "pass", failures: "pass" },
  },
  {
    id: "448-s3-before",
    note: "A direct question answered with a 1,639-character essay: numbered reasons, alternatives and an offer.",
    input: {
      request: "Message from Ada: Why do you ask for Apple Health after the questions?",
      facts: "No change to the canvas or the repository. Nothing failed.",
      midTurn: [],
      closing: `I put it after the questions for three reasons:

1. **You only get one real shot at the iOS sheet.** Once someone taps "Don't Allow" in the Health permission sheet, the app can't show that sheet again. They'd have to dig through Settings or the Health app to turn it on. So I ask when a yes is most likely, and the 5 Apple Health screen explains what's read and written before the system sheet appears.

2. **By then the request makes sense.** At the start it's a stranger asking for your health data. After you've picked a goal, a level and your training days, "so your plan can see how you're sleeping and recovering" connects to something you just built. People have also put in effort by then, so they're less likely to quit at a permission step.

3. **The data arrives right before it's used.** It's the last step before 6 Building plan, so sleep and resting heart rate can shape the plan from week 1.

There are two other placements that could make sense:

- **Health first, then pre-filled answers.** If someone already logs workouts, reading their history could pre-select 3 Experience, and maybe 4 Schedule. That means fewer questions for experienced users, but it asks before any trust is built, and people who don't track anything see an extra step for nothing.
- **Split it.** Ask to read sleep and heart rate where it is now. Ask to write workouts at the end of the first workout ("Save this to Apple Health?"), which is the most natural moment for that request.

I'd keep it where it is, and I'd consider the split if fewer people accept than you'd like. Do you want me to mock up either alternative next to the current flow?`,
      prDescription: null,
    },
    expect: { closing: "fail", failures: "pass" },
  },
  {
    // The founder's call is open on whether three paragraphs of plain prose is too long for
    // this question (docs/evals.md): only that no board was needed is labelled.
    id: "448-s3-after",
    note: "A direct answer in prose, no board: the right place for it.",
    input: {
      request: NOTIFICATIONS,
      facts: "No change to the canvas or the repository. Nothing failed.",
      midTurn: [],
      closing: `Because by then the reminder can be specific. After the schedule screen we know the training days, so the reminders screen can show a real example ("Upper body, 30 min" on Wednesday at 7:30) and promise nothing on rest days. If we asked at launch, it would just be a generic "Allow notifications?" with nothing behind it yet.

It also protects the system prompt. iOS only shows its notification prompt once, and if someone declines, the only way back is through Settings. So the reminders screen works as a pre-ask: the system prompt only appears after someone taps "Turn on reminders", and "Not now" skips it without burning that one chance.

It's also the last thing before the plan reveal, so skipping it costs nothing. Notifications are the only permission in the flow so far. Apple Health is still an open question on the note; if we add it, I'd put it in the same place for the same reason.`,
      prDescription: null,
    },
    expect: { canvas_detail: "pass", mid_turn: "pass" },
  },
  {
    id: "448-s4-before",
    note: "Options and a recommendation as a 2,402-character essay with headings in the thread, and no board.",
    input: {
      request: PAYWALL,
      facts: "No change to the canvas or the repository. Nothing failed.",
      midTurn: [],
      closing: `There are two decisions here: where the paywall appears and what it offers.

**Where it goes**

1. **Before the plan is revealed** (between 6 Building plan and 7 Plan ready). "Your plan is ready, start your trial to see it." Many fitness apps do this because people are most curious at that moment. The downside is that it holds back the plan they just answered questions for, which feels like a bait-and-switch and tends to show up in reviews.
2. **After the plan, on "Start today's workout."** They see their actual week, with real dates and their sessions, and the paywall appears when they tap to start. Interest is still high and they've seen what they'd pay for.
3. **After the first workout or first week.** The first workout or week is free, and the paywall comes once they've felt the product. Fewer people reach it, but those who pay stick around and ask for fewer refunds.
4. **Freemium.** The basic plan is free forever, and premium features (a plan that adapts, insights from Health, a full exercise library) are locked where they appear. It's the friendliest option and earns the least, and it means deciding what's free versus paid across the whole app, not only in onboarding.

**What it offers**
- A free trial, usually 7 days. Annual is selected by default, with monthly as the alternative.
- A clear timeline of the trial: "Today: full access · Day 5: we remind you · Day 7: billed." That builds trust, and it makes Apple's rules on showing trial terms easy to meet.

**What I'd pick: option 2, with a close button.**
- The flow is built to end on the first workout, so the paywall belongs on that button, not in front of the plan. Hiding the plan would undercut the four questions before it.
- If they close it, they can still do today's workout. The paywall comes back at the end of that workout, framed as "Unlock the rest of week 1." That borrows the best part of option 3 without giving away a whole week.
- No account is needed to buy, since the purchase goes through their Apple ID. That fits with account creation coming after the first workout.

The one thing that's your call is whether there's a permanent free tier (option 4). That's a business-model decision, and it changes what the close button leads to.

If you want, I can mock up option 2 as a "7b Paywall" screen with the trial timeline next to 7 Plan ready. I could also add option 1 beside it so you can compare.`,
      prDescription: null,
    },
    expect: { closing: "fail", canvas_detail: "fail" },
  },
  {
    id: "448-s4-after",
    note: "The options on a 'Note: Paywall options' board; the thread has the pick, why, and the one assumption.",
    input: {
      request: PAYWALL,
      facts:
        "Made a board named 'Note: Paywall options' on the Onboarding page with four options side by side. No repository change. Nothing failed.",
      midTurn: [],
      closing: `I'd go with a soft paywall right after the plan screen. All four options are side by side on the "Note: Paywall options" board, next to the flow note.

The soft version offers the trial while interest is highest, with a "Not now". People who skip get week 1 free, then the offer comes back with their own progress as proof ("you did 4 of 4 sessions"). A hard wall at that point would make people pay before the plan has had a chance to adjust, and that's Cadence's whole pitch. Waiting until after the first workout means a lot of people never see the offer at all.

I've assumed a subscription with a free trial; the board doesn't cover one-off purchases. I haven't designed the paywall screen yet, so tell me which option you want and I'll build it after "7 Your plan".`,
      prDescription: null,
    },
    expect: { closing: "pass", canvas_detail: "pass", mid_turn: "pass" },
  },
  {
    id: "448-s5-before",
    note: "The push failure is said, but buried in the fourth paragraph of a recap with bold headings.",
    input: {
      request: GREEN,
      facts:
        "Changed the accent to deep green (#1D6B47) on all seven screens, with a lighter green (#5CC98A) on dark surfaces; updated the note board, the spec and the screenshots. Committed locally. git push failed: the remote said 'Repository not found' (pre-receive hook declined). Nothing new is on the remote branch. The open pull request still shows the orange version.",
      midTurn: [
        "The green holds up on every screen, light and dark. Now I'm updating the note board copy, spec, exports and pull request.",
        "The push was rejected, so I'm checking what's on the remote branch.",
      ],
      closing: `The accent is now deep green (#1D6B47) on all seven screens. That covers the buttons, the highlighted bar on Welcome, the "Your plan is ready" label and the week strip. The change is committed locally, but the branch didn't push.

**One change you didn't ask for:** deep green is too dark to read on the black surfaces, like the selected option cards, the 6 Building plan screen and Today's session on 7 Plan ready. In those spots I used a lighter green from the same family (#5CC98A), with dark checkmarks instead of white. If you'd rather have deep green everywhere, it works, but the checks and the "TODAY" label get hard to read on black.

I also updated the note board text (it said "orange"), the color list in \`docs/onboarding/README.md\`, the screen images and the design brief.

**The push failed.** The remote rejected it with "Repository not found" (pre-receive hook declined), even though the two earlier pushes this session worked. It isn't a conflict. Nothing new is on the remote, and the push is set up the same as before. So the pull request still shows the orange version, and I haven't updated its description. Once the remote accepts pushes again, I'll push and update the description. If it keeps failing, the Ponzu-hosted repo for this design may need checking on your side.`,
      prDescription: null,
    },
    expect: { closing: "fail", failures: "pass", mid_turn: "fail" },
  },
  {
    id: "448-s5-first-after",
    note: "The failure in its own paragraph with what it means; a compromise and a mismatch to decide on.",
    input: {
      request: GREEN,
      facts:
        "Changed the accent to deep green (#1D6B47) on every screen and in the notes, with a lighter green (#5DBE8A) for small details on black. Committed locally. git push failed: 'Repository not found'. The branch on GitHub and the pull request description still describe the orange version.",
      midTurn: [
        "Green's in; brightening the small green details that sit on black (day dots, plan label, notification icon, Goal radio) so they stay legible.",
        "Now re-exporting the screens and updating the spec.",
      ],
      closing: `The accent is now deep green (#1D6B47) on every screen and in the notes. On black, that green came out murky for small things, so the day dots, the "Your plan is ready" label, the Goal radio and the notification icon use a lighter green (#5DBE8A).

The change is committed locally, but the push failed. The remote rejected it with "Repository not found", so I couldn't push and didn't force it. The branch on GitHub still has the orange version, and the pull request description still describes it. It may be a permissions issue or a renamed repo on Ponzu's side. I can retry once that's fixed.

Separately, "3 Experience" still uses the old check-mark style, so it doesn't match the bigger cards on "2 Goal". I can bring it in line if you want.`,
      prDescription: null,
    },
    expect: { closing: "pass", failures: "pass", mid_turn: "fail" },
  },
  {
    id: "448-s5-final",
    note: "The miss of the first trial: the failure and one plain consequence is enough.",
    hard: true,
    input: {
      request: GREEN,
      facts:
        "Changed the accent to deep green (#1C6B45) on every screen, with a lighter green for small text on the two dark screens. Committed the spec and screenshots locally. git push failed: 'Repository not found'. The remote branch and the open pull request still have the orange version.",
      midTurn: [
        "The deep green is too dark to read as small text on the two dark screens, so I'm adding a lighter green for those labels.",
        "Updating the repo spec and screenshots to match.",
      ],
      closing: `I changed the accent to a deep green (#1C6B45) on every screen. On the two dark screens, small green text like the "Cadence" wordmark was hard to read, so those labels use a lighter green instead.

The push didn't go through. I committed the updated spec and screenshots locally, but the remote rejected the push with "Repository not found", so the pushed branch still has the orange version. It looks like an access problem on the remote side; once it's sorted, I can push again.`,
      prDescription: null,
    },
    expect: { closing: "pass", failures: "pass", mid_turn: "fail" },
  },
  {
    id: "terse-enough",
    note: "Made up: one line that names the change and where it stands is a whole closing.",
    hard: true,
    input: {
      request: GREEN,
      facts:
        "Changed the accent token to deep green (#1D6B47); every screen board on the Onboarding page changed with it. Committed and pushed pz/fitness-onboarding: 1 of 1 commits on the remote branch. describe_pull_request was called; no pull request is open. Nothing failed.",
      midTurn: [],
      closing: "The accent is deep green on every screen; committed and pushed.",
      prDescription: null,
    },
    expect: { closing: "pass", failures: "pass", mid_turn: "pass" },
  },
  {
    id: "long-and-needed",
    note: "Made up: three short paragraphs, each a failure or a decision the person cannot see on the canvas.",
    hard: true,
    input: {
      request: ONBOARDING,
      facts:
        "Made 7 iPhone screen boards on the Onboarding page and a board named 'Note: How the flow works'. The screenshots of '5 Reminders' and '6 Building plan' failed to export, so the spec in docs/onboarding/ has placeholders for them. Committed locally. git push failed: 'Repository not found'. Nothing is on the remote branch. describe_pull_request was called; no pull request is open. A comment asking whether an account is needed before the first workout was pinned on '7 Your plan'.",
      midTurn: [],
      closing: `Seven screens, from a welcome through five questions to the plan, with the reasoning on the flow note.

Two things didn't work. The push was refused ("Repository not found"), so GitHub has none of this yet; it's committed here and I'll push once the remote takes it. And the screenshots of 5 Reminders and 6 Building plan wouldn't export, so the spec has placeholders for those two.

One decision is yours: whether people make an account before their first workout or after it. I've left the question pinned on 7 Your plan, and built it as "after" for now.`,
      prDescription: null,
    },
    expect: { closing: "pass", failures: "pass" },
  },
  {
    id: "push-refused-claimed",
    note: "Made up: the push was refused, and the close says it is on GitHub.",
    input: {
      request: GREEN,
      facts:
        "Changed the accent on seven screens. Committed locally. git push failed: 'Repository not found'. No pull request is open.",
      midTurn: [],
      closing:
        "The accent is deep green on every screen now. Committed and on GitHub; press Create PR when you're ready.",
      prDescription: null,
    },
    // Its closing has the right shape; what it claims is false, which is `failures`' to say.
    expect: { failures: "fail" },
  },
  {
    id: "pull-request-claimed",
    note: "Made up: says it opened a pull request when none is open.",
    input: {
      request: ONBOARDING,
      facts:
        "Made 7 iPhone screens on the Onboarding page. Committed and pushed pz/fitness-onboarding. describe_pull_request answered that no pull request is open and the description was saved for the one the person opens. Nothing failed.",
      midTurn: [],
      closing:
        "The seven onboarding screens are on the Onboarding page. I've opened a pull request with the spec and screenshots, so it's ready for review.",
      prDescription: null,
    },
    expect: { failures: "fail" },
  },
  {
    id: "451-r1-t1",
    note: "Two links, to the hero and the note, each with the board's name as its text.",
    input: {
      request:
        "Message from Ada: Design a pricing page hero for Stillwater, a meditation app: three options side by side to choose from, and a note board that compares them and says which you'd pick.",
      facts:
        "Made boards 'Pricing hero' and 'Note: Which plan to pick' on page Home. Scratch design: no repository. Nothing failed.",
      midTurn: [],
      closing: `I've built the pricing hero on the canvas, with the note board beside it.

[Pricing hero](${LINK}?artboard=ab_dybd2) has the headline and three plan cards side by side:
- **Monthly:** $12 a month.
- **Yearly:** $6.67 a month, billed $80 a year. It's the one filled, raised card, with a "Save 44%" badge.
- **Lifetime:** $199 once.

[Note: Which plan to pick](${LINK}?artboard=ab_6qptl) compares the plans on price, break-even, family seats, commitment and best use. It says I'd pick Yearly. A year gives a meditation habit time to take hold, and it costs 44% less than Monthly. The note uses light and dark colours, so it reads on either canvas theme.

The plan names, prices, feature lists and the 14-day trial are placeholders I made up, so swap in Stillwater's real ones. The break-even figures on the note board come from those prices, so they'll need updating too.

I shortened the Yearly price suffix to "/ mo · $80 a year" after it wrapped onto two lines. I haven't re-screenshotted that change.`,
      prDescription: null,
    },
    expect: { links: "pass" },
  },
  {
    id: "451-r1-t2",
    note: "The board is linked; the new page is named in passing without a link: still right.",
    hard: true,
    input: {
      request:
        "Message from Ada: Make a mobile version of the option you recommended, on its own page called Mobile.",
      facts:
        "Made page 'Mobile' and board 'Yearly plan – mobile' on it. Scratch design. Nothing failed.",
      midTurn: [],
      closing: `I've made the mobile version of Yearly, the plan I recommended, on a new page called Mobile. The artboard is [Yearly plan – mobile](${LINK}?artboard=ab_bd49f), 390px wide. The screenshot shows no layout problems.

It keeps the same filled green card, "Save 44%" badge, $6.67 a month price and feature list. The headline is smaller and the layout is a single column. Under the card, a line reads "Prefer another option? Monthly $12 · Lifetime $199". On mobile that line stands in for the other two plan cards.

The links in that line are text only, and they don't go anywhere yet. If you'd rather show Monthly and Lifetime as compact cards stacked under Yearly, I can do that.`,
      prDescription: null,
    },
    expect: { links: "pass" },
  },
  {
    id: "451-r1-t3",
    note: "Asked where to look: both boards it sends the person to are linked.",
    input: {
      request:
        "Message from Ada: Where can I see why you picked that one, and which board should I look at first on my phone?",
      facts: "No change to the canvas. Scratch design. Nothing failed.",
      midTurn: [],
      closing: `The reasoning is on [Note: Which plan to pick](${LINK}?artboard=ab_6qptl), the board beside the desktop hero on the Home page. It has a comparison table and my reasons for choosing Yearly:

- A year gives a meditation habit time to take hold.
- It costs 44% less than Monthly.
- Monthly stays as the low-risk option for the unsure.
- Lifetime suits a committed household, and it makes Yearly's price look modest.

On your phone, look at [Yearly plan – mobile](${LINK}?artboard=ab_bd49f) first. It's on the Mobile page, 390px wide, so it fits a phone screen at its real size. The note board is wide at 760px, so it will be small on a phone. Pinch to zoom in, or read it on a larger screen.`,
      prDescription: null,
    },
    expect: { links: "pass" },
  },
  {
    id: "where-unlinked",
    note: "Made up: sends the person to a board by name with no link.",
    input: {
      request: "Message from Ada: Where can I see why you picked that plan?",
      facts: "No change to the canvas. Scratch design. Nothing failed.",
      midTurn: [],
      closing:
        "The reasoning is on Note: Which plan to pick, beside the hero on the Home page: I'd lead with Yearly because a year gives the habit time to take hold.",
      prDescription: null,
    },
    expect: { links: "fail" },
  },
  {
    id: "link-text-here",
    note: "Made up: the link's text is 'here', not the board's name.",
    input: {
      request: "Message from Ada: Which board should I look at first on my phone?",
      facts: "No change to the canvas. Scratch design. Nothing failed.",
      midTurn: [],
      closing: `Start [here](${LINK}?artboard=ab_bd49f): it's the phone version of Yearly, at its real 390px width.`,
      prDescription: null,
    },
    expect: { links: "fail" },
  },
  {
    id: "every-board-linked",
    note: "Made up: a recap of six boards, every one linked, after a plain request.",
    input: {
      request: ONBOARDING,
      facts: "Made six iPhone screens on the Onboarding page. Scratch design. Nothing failed.",
      midTurn: [],
      closing: `Here's the flow:
- [1 Welcome](${LINK}?artboard=ab_a1): the headline and Get started.
- [2 Goal](${LINK}?artboard=ab_a2): four goals.
- [3 Experience](${LINK}?artboard=ab_a3): four levels.
- [4 Schedule](${LINK}?artboard=ab_a4): the days.
- [5 Reminders](${LINK}?artboard=ab_a5): one nudge on training days.
- [6 Your plan](${LINK}?artboard=ab_a6): the week.`,
      prDescription: null,
    },
    expect: { links: "fail", closing: "fail" },
  },
  {
    id: "yes-no-as-board",
    note: "Made up: a yes-or-no question answered by making a board.",
    input: {
      request: "Message from Ada: Is the Continue button the same orange as the accent token?",
      facts:
        "Made a board named 'Note: Button color' explaining that the button uses var(--accent). No repository change. Nothing failed.",
      midTurn: [],
      closing:
        "I've put the answer on [Note: Button color](https://ponzu.design/designs/des_x?artboard=ab_c1).",
      prDescription: null,
    },
    expect: { canvas_detail: "fail" },
  },
  {
    id: "pr-full-account",
    note: "Made up: a description a reviewer who has not seen the canvas can follow.",
    input: {
      request: GREEN,
      facts:
        "Changed the accent to deep green on seven screens and in docs/onboarding/README.md. Committed and pushed. Nothing failed.",
      midTurn: [],
      closing:
        "The accent is deep green on every screen, with a lighter green for small text on the dark screens. It's committed and pushed; press Create PR when you're ready.",
      prDescription: `## Deep green accent

The onboarding's accent changes from signal orange (#FF5A1F) to deep green (#1C6B45), everywhere it was used: the main button, the selected days on 4 Schedule and the plan label on 7 Your plan.

- \`docs/onboarding/README.md\`: the token list says deep green, and why.
- \`docs/onboarding/screens/*.png\`: the seven screens, exported again.

Deep green is too dark for small text on the two dark screens (6 Building plan, 7 Your plan), so those labels use a lighter green (#5CC98A). Open: whether the lighter green should be a token of its own.`,
    },
    expect: { pr_description: "pass" },
  },
  {
    id: "pr-one-line",
    note: "Made up: a one-line description that tells a reviewer nothing.",
    input: {
      request: GREEN,
      facts:
        "Changed the accent to deep green on seven screens and in docs/onboarding/README.md. Committed and pushed. Nothing failed.",
      midTurn: [],
      closing:
        "The accent is deep green on every screen. It's committed and pushed; press Create PR when you're ready.",
      prDescription: "Updated colors.",
    },
    expect: { pr_description: "fail" },
  },
];
