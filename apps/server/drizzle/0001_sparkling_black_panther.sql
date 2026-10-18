ALTER TABLE "runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "messages" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "phase" text;