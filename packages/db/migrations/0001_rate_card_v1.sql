-- The credit model as it launches: $0.10 a credit, 5 credits per awake sandbox hour, 100 free
-- per member each month, a $100 default cap with a warning at 80%, sleep after 5 idle minutes.
-- A price change is a new version, never an edit to this one.
INSERT INTO "rate_cards" (
	"version",
	"effective_from",
	"credit_microusd",
	"sandbox_credits_per_awake_hour",
	"free_credits_per_member",
	"default_cap_cents",
	"cap_warning_fraction",
	"idle_sleep_seconds"
) VALUES (1, '2026-11-01T00:00:00Z', 100000, 5, 100, 10000, 0.8, 300);
