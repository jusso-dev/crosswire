CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "app_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kql_proposals" ADD COLUMN "requested_by" text;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD COLUMN "digest_email" text;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD COLUMN "digest_email_pending" text;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD COLUMN "digest_email_token_hash" text;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD COLUMN "digest_email_token_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agent_decisions_created_idx" ON "agent_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_created_idx" ON "chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "hunt_evidence_created_idx" ON "hunt_evidence" USING btree ("created_at");