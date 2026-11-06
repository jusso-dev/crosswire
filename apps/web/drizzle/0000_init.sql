CREATE TYPE "public"."audit_category" AS ENUM('auth', 'agent', 'memory', 'ti', 'hunt', 'response', 'system');--> statement-breakpoint
CREATE TYPE "public"."kql_status" AS ENUM('proposed', 'approved', 'rejected', 'run', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'approver', 'analyst');--> statement-breakpoint
CREATE TYPE "public"."response_action_type" AS ENUM('sentinel_playbook', 'logic_app', 'graph_containment', 'other');--> statement-breakpoint
CREATE TYPE "public"."response_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."watch_type" AS ENUM('keyword', 'cve', 'vendor', 'tag');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_key" text NOT NULL,
	"action" text NOT NULL,
	"input_summary" text DEFAULT '' NOT NULL,
	"output_summary" text DEFAULT '' NOT NULL,
	"thread_id" text,
	"hunt_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"agent_key" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"agent_key" text NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"body" text NOT NULL,
	"source_type" text,
	"source_id" text,
	"redacted" boolean DEFAULT false NOT NULL,
	"compacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"category" "audit_category" NOT NULL,
	"action" text NOT NULL,
	"result" text DEFAULT 'success' NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"ip_address" text,
	"user_agent" text,
	"target_type" text,
	"target_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"agent_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text DEFAULT 'New thread' NOT NULL,
	"agent_key" text DEFAULT 'lead' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cve_records" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"cve_id" text NOT NULL,
	"vendor" text,
	"product" text,
	"title" text,
	"description" text,
	"severity" text,
	"published_at" text,
	"due_date" text,
	"known_ransomware" text,
	"url" text,
	"source_url" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"day" date NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hunt_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"hypothesis" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text,
	"thread_id" text,
	"watch_hit_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hunt_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"hunt_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kql_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"hunt_id" text NOT NULL,
	"target" text NOT NULL,
	"kql" text NOT NULL,
	"original_kql" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"status" "kql_status" DEFAULT 'proposed' NOT NULL,
	"proposed_by_type" text NOT NULL,
	"proposed_by_id" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"ran_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"result_summary" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rating" text NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text,
	"client_secret_ref" text,
	"sentinel_subscription_id" text,
	"sentinel_resource_group" text,
	"sentinel_workspace_name" text,
	"sentinel_workspace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_connectors_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
CREATE TABLE "org_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_role" DEFAULT 'analyst' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"entra_tenant_id" text,
	"email_domain" text,
	"is_personal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug"),
	CONSTRAINT "orgs_entra_tenant_id_unique" UNIQUE("entra_tenant_id")
);
--> statement-breakpoint
CREATE TABLE "pwn_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_slug" text NOT NULL,
	"incident_title" text,
	"category" text,
	"severity" text,
	"status" text,
	"date" text,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"upstream_source_url" text,
	"source" text DEFAULT 'pwn.watch' NOT NULL,
	"source_url" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pwn_incidents" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"category" text,
	"severity" text,
	"status" text,
	"patch_status" text,
	"product" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"stacks" text[] DEFAULT '{}' NOT NULL,
	"cve_ids" text[] DEFAULT '{}' NOT NULL,
	"started_at" text,
	"upstream_updated_at" text,
	"url" text NOT NULL,
	"source" text DEFAULT 'pwn.watch' NOT NULL,
	"source_url" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pwn_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"group" text,
	"group_label" text,
	"incidents" integer DEFAULT 0 NOT NULL,
	"url" text,
	"source" text DEFAULT 'pwn.watch' NOT NULL,
	"source_url" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "response_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "response_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"hunt_id" text,
	"title" text NOT NULL,
	"action_type" "response_action_type" NOT NULL,
	"targets" jsonb NOT NULL,
	"blast_radius" jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requester_type" text NOT NULL,
	"requester_id" text NOT NULL,
	"requested_by_user_id" text,
	"status" "response_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"last_dry_run" jsonb,
	"execution" jsonb,
	"rollback_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ti_fetch_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"etag" text,
	"last_modified" text,
	"status" integer NOT NULL,
	"body" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" "watch_type" NOT NULL,
	"value" text NOT NULL,
	"normalized" text NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "watch_hits" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"url" text,
	"cve_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD CONSTRAINT "agent_memory_entries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_cases" ADD CONSTRAINT "hunt_cases_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_cases" ADD CONSTRAINT "hunt_cases_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_cases" ADD CONSTRAINT "hunt_cases_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_cases" ADD CONSTRAINT "hunt_cases_watch_hit_id_watch_hits_id_fk" FOREIGN KEY ("watch_hit_id") REFERENCES "public"."watch_hits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_evidence" ADD CONSTRAINT "hunt_evidence_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_evidence" ADD CONSTRAINT "hunt_evidence_hunt_id_hunt_cases_id_fk" FOREIGN KEY ("hunt_id") REFERENCES "public"."hunt_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kql_proposals" ADD CONSTRAINT "kql_proposals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kql_proposals" ADD CONSTRAINT "kql_proposals_hunt_id_hunt_cases_id_fk" FOREIGN KEY ("hunt_id") REFERENCES "public"."hunt_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_connectors" ADD CONSTRAINT "org_connectors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_events" ADD CONSTRAINT "response_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_events" ADD CONSTRAINT "response_events_proposal_id_response_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."response_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_proposals" ADD CONSTRAINT "response_proposals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "response_proposals" ADD CONSTRAINT "response_proposals_hunt_id_hunt_cases_id_fk" FOREIGN KEY ("hunt_id") REFERENCES "public"."hunt_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_entries" ADD CONSTRAINT "watch_entries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_entries" ADD CONSTRAINT "watch_entries_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_hits" ADD CONSTRAINT "watch_hits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_hits" ADD CONSTRAINT "watch_hits_entry_id_watch_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."watch_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "agent_decisions_org_created_idx" ON "agent_decisions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memories_org_agent_uq" ON "agent_memories" USING btree ("org_id","agent_key");--> statement-breakpoint
CREATE INDEX "agent_memory_entries_org_agent_idx" ON "agent_memory_entries" USING btree ("org_id","agent_key","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_category_idx" ON "audit_events" USING btree ("category","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_threads_org_user_idx" ON "chat_threads" USING btree ("org_id","user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cve_records_source_cve_uq" ON "cve_records" USING btree ("source","cve_id");--> statement-breakpoint
CREATE INDEX "cve_records_cve_idx" ON "cve_records" USING btree ("cve_id");--> statement-breakpoint
CREATE UNIQUE INDEX "digests_org_day_uq" ON "digests" USING btree ("org_id","day");--> statement-breakpoint
CREATE INDEX "hunt_cases_org_idx" ON "hunt_cases" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "hunt_evidence_hunt_idx" ON "hunt_evidence" USING btree ("hunt_id","created_at");--> statement-breakpoint
CREATE INDEX "kql_proposals_hunt_idx" ON "kql_proposals" USING btree ("hunt_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_feedback_msg_user_uq" ON "message_feedback" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_memberships_org_user_uq" ON "org_memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "org_memberships_user_idx" ON "org_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pwn_incidents_retrieved_idx" ON "pwn_incidents" USING btree ("retrieved_at");--> statement-breakpoint
CREATE INDEX "response_events_proposal_idx" ON "response_events" USING btree ("proposal_id","created_at");--> statement-breakpoint
CREATE INDEX "response_proposals_org_status_idx" ON "response_proposals" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE INDEX "watch_entries_org_idx" ON "watch_entries" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_hits_dedupe_uq" ON "watch_hits" USING btree ("org_id","entry_id","source","source_id");--> statement-breakpoint
CREATE INDEX "watch_hits_org_created_idx" ON "watch_hits" USING btree ("org_id","created_at");