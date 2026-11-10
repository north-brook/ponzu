CREATE TABLE "auth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_states_kind_check" CHECK ("auth_states"."kind" in ('github_install', 'claude_sign_in'))
);
--> statement-breakpoint
CREATE TABLE "claude_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"encrypted_credential" text NOT NULL,
	"plan_label" text,
	"email" text,
	"key_hint" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"limits" jsonb,
	"limits_observed_at" timestamp with time zone,
	"limited_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claude_accounts_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "claude_accounts_kind_check" CHECK ("claude_accounts"."kind" in ('subscription', 'api_key')),
	CONSTRAINT "claude_accounts_status_check" CHECK ("claude_accounts"."status" in ('connected', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"push_token" text NOT NULL,
	"push_environment" text NOT NULL,
	"name" text,
	"app_version" text,
	"pings_enabled" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_push_token_unique" UNIQUE("push_token"),
	CONSTRAINT "devices_platform_check" CHECK ("devices"."platform" in ('ios', 'macos')),
	CONSTRAINT "devices_push_environment_check" CHECK ("devices"."push_environment" in ('development', 'production'))
);
--> statement-breakpoint
CREATE TABLE "github_user_tokens" (
	"user_id" text PRIMARY KEY NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"access_token_expires_at" timestamp with time zone,
	"encrypted_refresh_token" text,
	"refresh_token_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" in ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "repo_secrets" (
	"repo_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_secrets_repo_id_name_pk" PRIMARY KEY("repo_id","name"),
	CONSTRAINT "repo_secrets_name_check" CHECK ("repo_secrets"."name" ~ '^[A-Za-z_][A-Za-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"pushed_at" timestamp with time zone,
	"base_snapshot" text,
	"base_status" text DEFAULT 'none' NOT NULL,
	"base_built_at" timestamp with time zone,
	"base_error" text,
	"stack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ideas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ideas_generated_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_github_repo_id_unique" UNIQUE("github_repo_id"),
	CONSTRAINT "repos_base_status_check" CHECK ("repos"."base_status" in ('none', 'building', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"workos_user_id" text NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"name" text,
	"email" text,
	"avatar_url" text,
	"default_agent" text,
	"default_model" text,
	"default_effort" text,
	"ping_needs_you" boolean DEFAULT true NOT NULL,
	"ping_replies" boolean DEFAULT true NOT NULL,
	"ping_pr_ready" boolean DEFAULT true NOT NULL,
	"ping_teammate_comments" boolean DEFAULT true NOT NULL,
	"email_digest" boolean DEFAULT false NOT NULL,
	"onboarding_where_at" timestamp with time zone,
	"onboarding_iphone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_workos_user_id_unique" UNIQUE("workos_user_id"),
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"github_account_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"installation_id" bigint,
	"repository_selection" text,
	"installed_by_user_id" text,
	"installed_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"stripe_customer_id" text,
	"monthly_cap_cents" integer,
	"billing_period_anchor" timestamp with time zone DEFAULT now() NOT NULL,
	"card_brand" text,
	"card_last4" text,
	"past_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_github_account_id_unique" UNIQUE("github_account_id"),
	CONSTRAINT "workspaces_installation_id_unique" UNIQUE("installation_id"),
	CONSTRAINT "workspaces_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "workspaces_kind_check" CHECK ("workspaces"."kind" in ('personal', 'org')),
	CONSTRAINT "workspaces_repository_selection_check" CHECK ("workspaces"."repository_selection" in ('all', 'selected')),
	CONSTRAINT "workspaces_monthly_cap_cents_check" CHECK ("workspaces"."monthly_cap_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"delta" numeric(14, 4) NOT NULL,
	"reason" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"user_id" text,
	"usage_event_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_usage_event_id_unique" UNIQUE("usage_event_id"),
	CONSTRAINT "credit_ledger_reason_check" CHECK ("credit_ledger"."reason" in ('grant', 'use', 'topup', 'refund', 'adjustment')),
	CONSTRAINT "credit_ledger_delta_check" CHECK (case "credit_ledger"."reason" when 'use' then "credit_ledger"."delta" < 0 when 'adjustment' then "credit_ledger"."delta" <> 0 else "credit_ledger"."delta" > 0 end),
	CONSTRAINT "credit_ledger_usage_event_id_check" CHECK (("credit_ledger"."reason" = 'use') = ("credit_ledger"."usage_event_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "rate_cards" (
	"version" integer PRIMARY KEY NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"credit_microusd" integer NOT NULL,
	"sandbox_credits_per_awake_hour" numeric(14, 4) NOT NULL,
	"free_credits_per_member" numeric(14, 4) NOT NULL,
	"default_cap_cents" integer NOT NULL,
	"cap_warning_fraction" numeric(4, 3) NOT NULL,
	"idle_sleep_seconds" integer NOT NULL,
	"model_rates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"design_id" text,
	"user_id" text,
	"kind" text NOT NULL,
	"seconds" integer,
	"model" text,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cache_read_tokens" bigint,
	"cache_write_tokens" bigint,
	"cost_microusd" bigint DEFAULT 0 NOT NULL,
	"credits" numeric(14, 4) DEFAULT 0 NOT NULL,
	"payer" text NOT NULL,
	"rate_card_version" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_kind_check" CHECK ("usage_events"."kind" in ('sandbox', 'model')),
	CONSTRAINT "usage_events_payer_check" CHECK ("usage_events"."payer" in ('ponzu', 'own_plan')),
	CONSTRAINT "usage_events_seconds_check" CHECK (("usage_events"."kind" = 'sandbox') = ("usage_events"."seconds" is not null)),
	CONSTRAINT "usage_events_model_check" CHECK (("usage_events"."kind" = 'model') = ("usage_events"."model" is not null)),
	CONSTRAINT "usage_events_credits_check" CHECK ("usage_events"."credits" >= 0)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"design_id" text NOT NULL,
	"path" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_design_id_path_pk" PRIMARY KEY("design_id","path"),
	CONSTRAINT "assets_size_check" CHECK ("assets"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "design_checkpoints" (
	"design_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"doc" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_checkpoints_design_id_seq_pk" PRIMARY KEY("design_id","seq")
);
--> statement-breakpoint
CREATE TABLE "design_ops" (
	"design_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"client_op_id" text NOT NULL,
	"op" json NOT NULL,
	"inverse" json NOT NULL,
	"kind" text DEFAULT 'do' NOT NULL,
	"reverses_seq" bigint,
	"reversed_by_seq" bigint,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"actor_avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_ops_design_id_seq_pk" PRIMARY KEY("design_id","seq"),
	CONSTRAINT "design_ops_seq_check" CHECK ("design_ops"."seq" > 0),
	CONSTRAINT "design_ops_kind_check" CHECK ("design_ops"."kind" in ('do', 'undo', 'redo')),
	CONSTRAINT "design_ops_reverses_seq_check" CHECK (("design_ops"."kind" = 'do') = ("design_ops"."reverses_seq" is null)),
	CONSTRAINT "design_ops_actor_kind_check" CHECK ("design_ops"."actor_kind" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "design_reads" (
	"user_id" text NOT NULL,
	"design_id" text NOT NULL,
	"seen_seq" bigint DEFAULT 0 NOT NULL,
	"seen_thread_seq" bigint DEFAULT 0 NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_reads_user_id_design_id_pk" PRIMARY KEY("user_id","design_id")
);
--> statement-breakpoint
CREATE TABLE "designs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"repo_id" text,
	"owner_id" text,
	"claude_account_id" text,
	"name" text NOT NULL,
	"icon" text,
	"branch" text,
	"model" text,
	"effort" text,
	"status" text DEFAULT 'active' NOT NULL,
	"settled_at" timestamp with time zone,
	"seq" bigint DEFAULT 0 NOT NULL,
	"asset_key" text NOT NULL,
	"preview_seq" bigint,
	"pr_number" integer,
	"pr_state" text,
	"pr_checks" text DEFAULT 'none' NOT NULL,
	"pr_mergeable" boolean,
	"pr_auto_merge" boolean DEFAULT false NOT NULL,
	"agent_state" text DEFAULT 'idle' NOT NULL,
	"agent_status" text,
	"agent_artboards" text[] DEFAULT '{}'::text[] NOT NULL,
	"needs_you_count" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sandbox_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "designs_asset_key_unique" UNIQUE("asset_key"),
	CONSTRAINT "designs_status_check" CHECK ("designs"."status" in ('active', 'settled')),
	CONSTRAINT "designs_settled_at_check" CHECK (("designs"."status" = 'settled') = ("designs"."settled_at" is not null)),
	CONSTRAINT "designs_seq_check" CHECK ("designs"."seq" >= 0),
	CONSTRAINT "designs_pr_state_check" CHECK ("designs"."pr_state" in ('draft', 'open', 'merged', 'closed')),
	CONSTRAINT "designs_pr_number_check" CHECK (("designs"."pr_number" is null) = ("designs"."pr_state" is null)),
	CONSTRAINT "designs_pr_checks_check" CHECK ("designs"."pr_checks" in ('none', 'running', 'failing', 'passing')),
	CONSTRAINT "designs_agent_state_check" CHECK ("designs"."agent_state" in ('idle', 'waking', 'working', 'needs_you', 'limited')),
	CONSTRAINT "designs_needs_you_count_check" CHECK ("designs"."needs_you_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"design_id" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"priority" text NOT NULL,
	"payload" jsonb NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "events_kind_check" CHECK ("events"."kind" in ('message', 'answer', 'comment', 'edit', 'check', 'review')),
	CONSTRAINT "events_priority_check" CHECK ("events"."priority" in ('now', 'next', 'later'))
);
--> statement-breakpoint
CREATE TABLE "presence" (
	"design_id" text NOT NULL,
	"user_id" text NOT NULL,
	"page_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presence_design_id_user_id_pk" PRIMARY KEY("design_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"design_id" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "questions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" jsonb,
	"answered_by_user_id" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "questions_kind_check" CHECK ("questions"."kind" in ('question', 'permission', 'plan', 'elicitation', 'handoff', 'secret')),
	CONSTRAINT "questions_status_check" CHECK ("questions"."status" in ('open', 'answered', 'cancelled')),
	CONSTRAINT "questions_answer_check" CHECK (("questions"."status" = 'answered') = ("questions"."answer" is not null)),
	CONSTRAINT "questions_payload_check" CHECK (octet_length("questions"."payload"::text) <= 262144)
);
--> statement-breakpoint
CREATE TABLE "runner_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"design_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"design_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"state" text DEFAULT 'starting' NOT NULL,
	"address" text,
	"encrypted_address_token" text,
	"awake_since" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claude_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_provider_check" CHECK ("sandboxes"."provider" in ('boat')),
	CONSTRAINT "sandboxes_state_check" CHECK ("sandboxes"."state" in ('starting', 'awake', 'asleep', 'gone')),
	CONSTRAINT "sandboxes_awake_since_check" CHECK (("sandboxes"."state" = 'awake') = ("sandboxes"."awake_since" is not null))
);
--> statement-breakpoint
CREATE TABLE "thread_items" (
	"id" text PRIMARY KEY NOT NULL,
	"design_id" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "thread_items_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"user_id" text,
	"payload" jsonb NOT NULL,
	"streaming" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_items_kind_check" CHECK ("thread_items"."kind" in ('message', 'comment', 'assistant', 'tool', 'notice')),
	CONSTRAINT "thread_items_payload_check" CHECK (octet_length("thread_items"."payload"::text) <= 262144)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_locked_by_check" CHECK (("jobs"."locked_at" is null) = ("jobs"."locked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"source" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_source_delivery_id_pk" PRIMARY KEY("source","delivery_id"),
	CONSTRAINT "webhook_deliveries_source_check" CHECK ("webhook_deliveries"."source" in ('github', 'stripe', 'boat', 'workos'))
);
--> statement-breakpoint
ALTER TABLE "auth_states" ADD CONSTRAINT "auth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_accounts" ADD CONSTRAINT "claude_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_user_tokens" ADD CONSTRAINT "github_user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_secrets" ADD CONSTRAINT "repo_secrets_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_secrets" ADD CONSTRAINT "repo_secrets_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_rate_card_version_rate_cards_version_fk" FOREIGN KEY ("rate_card_version") REFERENCES "public"."rate_cards"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_checkpoints" ADD CONSTRAINT "design_checkpoints_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_ops" ADD CONSTRAINT "design_ops_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_reads" ADD CONSTRAINT "design_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_reads" ADD CONSTRAINT "design_reads_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_claude_account_id_claude_accounts_id_fk" FOREIGN KEY ("claude_account_id") REFERENCES "public"."claude_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answered_by_user_id_users_id_fk" FOREIGN KEY ("answered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_tokens" ADD CONSTRAINT "runner_tokens_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_items" ADD CONSTRAINT "thread_items_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_items" ADD CONSTRAINT "thread_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_states_expires_at_idx" ON "auth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "repos_workspace_id_idx" ON "repos" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_workspace_id_period_start_idx" ON "credit_ledger" USING btree ("workspace_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_grant_key" ON "credit_ledger" USING btree ("workspace_id","period_start","user_id") WHERE "credit_ledger"."reason" = 'grant';--> statement-breakpoint
CREATE INDEX "usage_events_workspace_id_occurred_at_idx" ON "usage_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "design_ops_design_id_client_op_id_key" ON "design_ops" USING btree ("design_id","client_op_id");--> statement-breakpoint
CREATE INDEX "design_reads_design_id_idx" ON "design_reads" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "designs_workspace_id_status_idx" ON "designs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "designs_repo_id_branch_key" ON "designs" USING btree ("repo_id","branch");--> statement-breakpoint
CREATE INDEX "events_design_id_seq_pending_idx" ON "events" USING btree ("design_id","seq") WHERE "events"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "questions_design_id_status_idx" ON "questions" USING btree ("design_id","status");--> statement-breakpoint
CREATE INDEX "runner_tokens_design_id_idx" ON "runner_tokens" USING btree ("design_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_provider_provider_id_key" ON "sandboxes" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sandboxes_design_id_live_key" ON "sandboxes" USING btree ("design_id") WHERE "sandboxes"."state" <> 'gone';--> statement-breakpoint
CREATE INDEX "sandboxes_awake_last_activity_at_idx" ON "sandboxes" USING btree ("last_activity_at") WHERE "sandboxes"."state" = 'awake';--> statement-breakpoint
CREATE INDEX "thread_items_design_id_seq_idx" ON "thread_items" USING btree ("design_id","seq");--> statement-breakpoint
CREATE INDEX "jobs_run_at_pending_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."completed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_kind_key_pending_key" ON "jobs" USING btree ("kind","key") WHERE "jobs"."completed_at" is null;