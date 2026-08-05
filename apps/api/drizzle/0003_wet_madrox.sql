ALTER TABLE "usage_events" ADD COLUMN "grain" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "cache_creation_tokens" integer;