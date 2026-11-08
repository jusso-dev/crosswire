ALTER TABLE "agent_memory_entries" ADD COLUMN "trust" text DEFAULT 'operator' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "visibility" text DEFAULT 'org' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "sdk_class" text;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "sdk_allowed" boolean;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "promoted_by" text;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "promoted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "response_proposals" ADD COLUMN "payload_sha256" text;--> statement-breakpoint
ALTER TABLE "response_proposals" ADD COLUMN "payload_schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"parent_run_id" text,
	"thread_id" text,
	"agent_key" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"model_provider" text,
	"model_name" text,
	"charter_sha256" text,
	"policy_sha256" text,
	"toolset_sha256" text,
	"memory_sha256" text,
	"sdk_version" text,
	"cancel_requested_at" timestamp with time zone,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_run_id_agent_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "agent_run_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "agent_run_outputs" ADD CONSTRAINT "agent_run_outputs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_outputs" ADD CONSTRAINT "agent_run_outputs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "agent_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"run_id" text,
	"agent_key" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"estimated_cost_micros" integer,
	"observed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "agent_capacity" (
	"org_id" text PRIMARY KEY NOT NULL,
	"inflight" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "agent_capacity" ADD CONSTRAINT "agent_capacity_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "org_directives" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_sha256" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'operator' NOT NULL,
	"created_by" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"supersedes" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "org_directives" ADD CONSTRAINT "org_directives_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "soc_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"incident_ref" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "soc_reviews" ADD CONSTRAINT "soc_reviews_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "soc_handovers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"shift_label" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "soc_handovers" ADD CONSTRAINT "soc_handovers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_org_status_idx" ON "agent_runs" USING btree ("org_id","status","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_parent_idx" ON "agent_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_events_run_seq_uq" ON "agent_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "agent_run_outputs_run_idx" ON "agent_run_outputs" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_usage_org_created_idx" ON "agent_usage" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "org_directives_org_status_idx" ON "org_directives" USING btree ("org_id","status","created_at");