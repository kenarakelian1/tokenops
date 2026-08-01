-- machines.machine_id was declared with an inline `.primaryKey()`, so Postgres
-- assigned it the default single-column constraint name `machines_pkey`.
ALTER TABLE "machines" DROP CONSTRAINT "machines_pkey";--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_user_id_machine_id_pk" PRIMARY KEY("user_id","machine_id");