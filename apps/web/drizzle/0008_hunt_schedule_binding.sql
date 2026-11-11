ALTER TABLE "hunt_schedules" ADD COLUMN "approved_context" jsonb;--> statement-breakpoint
-- #207: before the unique index, pause every enabled schedule that duplicates an older enabled one
-- for the same query (the bug let this happen). The oldest stays enabled; a person can re-approve.
UPDATE "hunt_schedules" AS s SET "enabled" = false, "disabled_reason" = 'duplicate schedule for the same query; paused by upgrade'
WHERE s."enabled" AND s."source_proposal_id" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "hunt_schedules" AS o
  WHERE o."enabled" AND o."source_proposal_id" = s."source_proposal_id"
    AND (o."created_at" < s."created_at" OR (o."created_at" = s."created_at" AND o."id" < s."id"))
);--> statement-breakpoint
CREATE UNIQUE INDEX "hunt_schedules_source_enabled_uq" ON "hunt_schedules" USING btree ("source_proposal_id") WHERE "hunt_schedules"."enabled";
