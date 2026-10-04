ALTER TABLE "contacts" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "marked_bad_at" timestamp with time zone;