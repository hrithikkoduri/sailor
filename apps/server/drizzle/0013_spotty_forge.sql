CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"job_id" text NOT NULL,
	"command" text,
	"sandbox_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"output" text,
	"timeout_secs" integer DEFAULT 3600 NOT NULL,
	"launched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "background_jobs_job_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "background_jobs_running_idx" ON "background_jobs" USING btree ("status","launched_at");