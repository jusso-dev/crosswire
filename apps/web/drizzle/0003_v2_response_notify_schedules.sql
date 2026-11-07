CREATE TYPE "public"."notification_kind" AS ENUM('teams', 'slack');--> statement-breakpoint
CREATE TABLE "hunt_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"hunt_id" text NOT NULL,
	"source_proposal_id" text,
	"target" text NOT NULL,
	"kql" text NOT NULL,
	"interval_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"approval_expires_at" timestamp with time zone NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_row_count" integer,
	"last_error" text,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"name" text NOT NULL,
	"url_enc" text NOT NULL,
	"url_host" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_status" text,
	"last_sent_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_response_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text,
	"client_secret_ref" text,
	"playbook_allowlist" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_response_connectors_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
ALTER TABLE "response_proposals" ADD COLUMN "rollback_of_id" text;--> statement-breakpoint
ALTER TABLE "hunt_schedules" ADD CONSTRAINT "hunt_schedules_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_schedules" ADD CONSTRAINT "hunt_schedules_hunt_id_hunt_cases_id_fk" FOREIGN KEY ("hunt_id") REFERENCES "public"."hunt_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_schedules" ADD CONSTRAINT "hunt_schedules_source_proposal_id_kql_proposals_id_fk" FOREIGN KEY ("source_proposal_id") REFERENCES "public"."kql_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_notification_channels" ADD CONSTRAINT "org_notification_channels_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_notification_channels" ADD CONSTRAINT "org_notification_channels_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_response_connectors" ADD CONSTRAINT "org_response_connectors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hunt_schedules_due_idx" ON "hunt_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "hunt_schedules_hunt_idx" ON "hunt_schedules" USING btree ("hunt_id");--> statement-breakpoint
CREATE INDEX "org_notification_channels_org_idx" ON "org_notification_channels" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "response_proposals" ADD CONSTRAINT "response_proposals_rollback_of_id_response_proposals_id_fk" FOREIGN KEY ("rollback_of_id") REFERENCES "public"."response_proposals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "response_proposals_rollback_of_uq" ON "response_proposals" USING btree ("rollback_of_id") WHERE "response_proposals"."rollback_of_id" IS NOT NULL AND "response_proposals"."status" IN ('pending', 'approved', 'executed');