ALTER TABLE "runs" ADD COLUMN "disposition" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "watch" jsonb;