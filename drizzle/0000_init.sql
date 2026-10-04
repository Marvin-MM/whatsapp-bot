CREATE TYPE "public"."ai_purpose" AS ENUM('draft', 'verify', 'analysis', 'style_extract', 'transcribe', 'eval');--> statement-breakpoint
CREATE TYPE "public"."audit_actor" AS ENUM('owner', 'system', 'autopilot');--> statement-breakpoint
CREATE TYPE "public"."contact_source" AS ENUM('webhook', 'import_phone', 'import_name');--> statement-breakpoint
CREATE TYPE "public"."content_source" AS ENUM('text', 'caption', 'transcript', 'rendered', 'template');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'waiting_on_me', 'waiting_on_customer', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."draft_intent" AS ENUM('question', 'order', 'complaint', 'scheduling', 'payment', 'chit_chat', 'asks_for_human', 'other');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('pending', 'scheduled', 'approved', 'edited', 'rejected', 'superseded', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts', 'interactive', 'button', 'reaction', 'template', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('customer', 'owner_manual', 'owner_app_echo', 'imported', 'ai_unedited', 'ai_edited', 'ai_autopilot');--> statement-breakpoint
CREATE TYPE "public"."reply_mode" AS ENUM('approval', 'autopilot');--> statement-breakpoint
CREATE TYPE "public"."task_created_by" AS ENUM('ai', 'owner');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('request', 'followup', 'reminder');--> statement-breakpoint
CREATE TYPE "public"."transcription_status" AS ENUM('pending', 'done', 'failed', 'low_confidence');--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" "ai_purpose" NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"draft_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor" "audit_actor" NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bsuid" text,
	"phone_e164" text,
	"source" "contact_source" DEFAULT 'webhook' NOT NULL,
	"display_name" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_bsuid_unique" UNIQUE("bsuid"),
	CONSTRAINT "contacts_phone_e164_unique" UNIQUE("phone_e164"),
	CONSTRAINT "contacts_identity_present" CHECK ("contacts"."bsuid" IS NOT NULL OR "contacts"."phone_e164" IS NOT NULL OR "contacts"."source" = 'import_name')
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"reply_mode" "reply_mode" DEFAULT 'approval' NOT NULL,
	"autopilot_until" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"window_expires_at" timestamp with time zone,
	"summary" text,
	"summary_through_message_id" uuid,
	"consecutive_auto_replies" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_contact_id_unique" UNIQUE("contact_id")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_ids" uuid[] NOT NULL,
	"content" text NOT NULL,
	"original_content" text NOT NULL,
	"intent" "draft_intent" NOT NULL,
	"analysis" text NOT NULL,
	"missing_facts" text[] DEFAULT '{}'::text[] NOT NULL,
	"risk_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"no_reply_needed" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"style_guide_version" integer,
	"fewshot_message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" "draft_status" DEFAULT 'pending' NOT NULL,
	"autopilot_decision" jsonb,
	"scheduled_send_at" timestamp with time zone,
	"final_message_id" uuid,
	"edit_distance" real,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"style_guide_version" integer,
	"sample_size" integer NOT NULL,
	"median_edit_distance" real NOT NULL,
	"invented_fact_rate" real NOT NULL,
	"forbidden_hit_rate" real NOT NULL,
	"report_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"wamid" text,
	"idempotency_key" text,
	"type" "message_type" NOT NULL,
	"content" text,
	"content_source" "content_source",
	"media_id" text,
	"media_mime" text,
	"media_path" text,
	"reply_to_message_id" uuid,
	"provenance" "provenance" NOT NULL,
	"status" "message_status" NOT NULL,
	"error" jsonb,
	"template_name" text,
	"transcription_status" "transcription_status",
	"send_started_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED,
	CONSTRAINT "messages_wamid_unique" UNIQUE("wamid"),
	CONSTRAINT "messages_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"telegram_message_id" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"owner_name" text DEFAULT '' NOT NULL,
	"business_name" text DEFAULT '' NOT NULL,
	"business_profile" text DEFAULT '' NOT NULL,
	"ai_paused" boolean DEFAULT false NOT NULL,
	"sending_paused" boolean DEFAULT false NOT NULL,
	"autopilot_paused" boolean DEFAULT true NOT NULL,
	"autopilot_allowed_intents" text[] DEFAULT '{chit_chat,question}'::text[] NOT NULL,
	"autopilot_delay_seconds" integer DEFAULT 120 NOT NULL,
	"autopilot_disclosure" text DEFAULT '(sent by my assistant)' NOT NULL,
	"autopilot_max_per_conversation_per_hour" integer DEFAULT 3 NOT NULL,
	"autopilot_max_per_day" integer DEFAULT 30 NOT NULL,
	"autopilot_max_consecutive" integer DEFAULT 4 NOT NULL,
	"quiet_hours" jsonb DEFAULT '{"start":"22:00","end":"07:00"}'::jsonb NOT NULL,
	"notify_telegram" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "style_guides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"source_message_count" integer NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "style_guides_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_message_id" uuid,
	"description" text NOT NULL,
	"type" "task_type" NOT NULL,
	"due_at" timestamp with time zone,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"created_by" "task_created_by" NOT NULL,
	"alerted_overdue_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "webhook_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_final_message_id_messages_id_fk" FOREIGN KEY ("final_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_recent_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "conversations_list_idx" ON "conversations" USING btree ("last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_window_idx" ON "conversations" USING btree ("window_expires_at");--> statement-breakpoint
CREATE INDEX "conversations_status_idx" ON "conversations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "drafts_open_idx" ON "drafts" USING btree ("created_at") WHERE "drafts"."status" IN ('pending','scheduled');--> statement-breakpoint
CREATE INDEX "drafts_conversation_idx" ON "drafts" USING btree ("conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_content_tsv_idx" ON "messages" USING gin ("content_tsv");--> statement-breakpoint
CREATE INDEX "messages_problem_idx" ON "messages" USING btree ("status") WHERE "messages"."status" IN ('queued','unknown','failed');--> statement-breakpoint
CREATE UNIQUE INDEX "style_guides_one_active_idx" ON "style_guides" USING btree ("is_active") WHERE "style_guides"."is_active";--> statement-breakpoint
CREATE INDEX "tasks_status_due_idx" ON "tasks" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "webhook_events_unprocessed_idx" ON "webhook_events" USING btree ("received_at") WHERE "webhook_events"."processed_at" IS NULL;