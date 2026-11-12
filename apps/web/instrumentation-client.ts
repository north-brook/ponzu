import posthog from "posthog-js";
import { startSiteAnalytics } from "@/components/site-analytics";

// The key is set on Vercel for ponzu.design; local and fork builds send nothing. Do Not Track or
// Global Privacy Control: nothing starts at all (components/site-analytics.ts).
startSiteAnalytics(window, posthog, process.env.NEXT_PUBLIC_POSTHOG_KEY);
