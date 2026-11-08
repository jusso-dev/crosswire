ALTER TABLE "agent_runs" ADD COLUMN "slot_held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "slot_released" boolean DEFAULT false NOT NULL;
