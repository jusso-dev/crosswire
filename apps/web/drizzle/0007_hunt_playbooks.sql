CREATE TABLE "hunt_playbooks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"indicator_kind" text NOT NULL,
	"checks" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hunt_playbooks" ADD CONSTRAINT "hunt_playbooks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hunt_playbooks" ADD CONSTRAINT "hunt_playbooks_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hunt_playbooks_org_idx" ON "hunt_playbooks" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "hunt_playbooks_org_name_uq" ON "hunt_playbooks" USING btree ("org_id","name");