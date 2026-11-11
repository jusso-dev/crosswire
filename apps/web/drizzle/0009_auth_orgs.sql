CREATE TABLE "entra_role_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"role" "org_role" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_member_removals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"removed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sso_provider" ADD COLUMN "domain_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_memberships" ADD COLUMN "role_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "entra_require_mapped_group" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "entra_role_mappings" ADD CONSTRAINT "entra_role_mappings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entra_role_mappings" ADD CONSTRAINT "entra_role_mappings_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_removals" ADD CONSTRAINT "org_member_removals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_removals" ADD CONSTRAINT "org_member_removals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_member_removals" ADD CONSTRAINT "org_member_removals_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entra_role_mappings_org_kind_value_uq" ON "entra_role_mappings" USING btree ("org_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "org_member_removals_org_user_uq" ON "org_member_removals" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_provider_domain_uq" ON "sso_provider" USING btree (lower("domain"));