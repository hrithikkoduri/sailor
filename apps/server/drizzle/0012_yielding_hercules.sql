ALTER TABLE "threads" ALTER COLUMN "budget_max_usd" SET DEFAULT '25.0';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "revival" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "revived" boolean DEFAULT false NOT NULL;