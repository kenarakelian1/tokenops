CREATE TABLE "limit_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"window_kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"units_in_window" numeric(20, 4) NOT NULL,
	"provenance" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "limit_observations" ADD CONSTRAINT "limit_observations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;