CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"name" text NOT NULL,
	"avatar_url" text,
	"phone" varchar(32),
	"professional_title" varchar(32),
	"registration_number" varchar(64),
	"locale" varchar(16),
	"timezone" varchar(64),
	"last_seen_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" varchar(32) NOT NULL,
	"kind" text DEFAULT 'retail' NOT NULL,
	"email" text,
	"phone" varchar(32),
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" varchar(16),
	"country_code" varchar(2),
	"currency" varchar(3),
	"timezone" varchar(64),
	"licence_number" varchar(64),
	"licence_expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"all_locations" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "membership_location" (
	"membership_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_location_membership_id_location_id_pk" PRIMARY KEY("membership_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"timezone" varchar(64) DEFAULT 'Africa/Lagos' NOT NULL,
	"default_currency" varchar(3) DEFAULT 'NGN' NOT NULL,
	"country_code" varchar(2) DEFAULT 'NG' NOT NULL,
	"locale" varchar(16) DEFAULT 'en-NG' NOT NULL,
	"billing_status" text DEFAULT 'trialing' NOT NULL,
	"plan_code" varchar(32) DEFAULT 'free' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "drug_catalog" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid,
	"generic_name" text NOT NULL,
	"brand_name" text,
	"strength" varchar(64),
	"dosage_form" varchar(48),
	"route" varchar(32),
	"manufacturer" text,
	"atc_code" varchar(16),
	"nafdac_number" varchar(32),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gtin" varchar(14),
	"controlled_schedule" varchar(16),
	"storage_condition" text DEFAULT 'ambient' NOT NULL,
	"shelf_life_after_opening_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"catalog_id" uuid,
	"category_id" uuid,
	"name" text NOT NULL,
	"sku" varchar(64),
	"barcode" varchar(32),
	"base_uom_id" uuid,
	"purchase_uom_id" uuid,
	"storage_condition" text DEFAULT 'ambient' NOT NULL,
	"is_controlled" boolean DEFAULT false NOT NULL,
	"requires_prescription" boolean DEFAULT false NOT NULL,
	"reorder_point" bigint,
	"reorder_quantity" bigint,
	"target_stock_level" bigint,
	"default_cost_minor" bigint,
	"default_price_minor" bigint,
	"currency" varchar(3),
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_category" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"color_hex" varchar(7),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_location_setting" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"reorder_point" bigint,
	"reorder_quantity" bigint,
	"target_stock_level" bigint,
	"price_minor" bigint,
	"is_stocked" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "product_supplier" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_sku" varchar(64),
	"last_cost_minor" bigint,
	"currency" varchar(3),
	"lead_time_days" integer,
	"minimum_order_quantity" bigint,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" varchar(32),
	"email" text,
	"phone" varchar(32),
	"address_line1" text,
	"city" text,
	"country_code" varchar(2),
	"accepts_returns" boolean DEFAULT false NOT NULL,
	"return_window_days_before_expiry" integer,
	"return_policy_notes" text,
	"credit_rate_percent" integer,
	"lead_time_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "unit_of_measure" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid,
	"code" varchar(16) NOT NULL,
	"name" text NOT NULL,
	"base_units_per" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "batch" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"supplier_id" uuid,
	"batch_number" varchar(64),
	"expiry_date" date NOT NULL,
	"expiry_precision" text DEFAULT 'day' NOT NULL,
	"expiry_is_estimated" boolean DEFAULT false NOT NULL,
	"manufactured_date" date,
	"opened_at" timestamp with time zone,
	"effective_expiry_date" date,
	"quantity_on_hand" bigint DEFAULT 0 NOT NULL,
	"quantity_reserved" bigint DEFAULT 0 NOT NULL,
	"quantity_received" bigint DEFAULT 0 NOT NULL,
	"unit_cost_minor" bigint,
	"currency" varchar(3),
	"status" text DEFAULT 'active' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_kind" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_count" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"kind" text DEFAULT 'cycle' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"started_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"applied_by" uuid,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_count_line" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"expected_quantity" bigint NOT NULL,
	"counted_quantity" bigint,
	"variance_reason" text,
	"counted_by" uuid,
	"counted_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stock_movement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_delta" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reason" text NOT NULL,
	"reference_type" varchar(48),
	"reference_id" uuid,
	"unit_cost_minor" bigint,
	"currency" varchar(3),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfer" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"dispatched_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_line" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stock_transfer_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"destination_batch_id" uuid,
	"quantity_sent" bigint NOT NULL,
	"quantity_received" bigint,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alert_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"alert_rule_id" uuid NOT NULL,
	"batch_id" uuid,
	"product_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"threshold_days" integer,
	"severity" smallint DEFAULT 3 NOT NULL,
	"days_remaining" integer,
	"quantity_at_alert" bigint,
	"value_at_risk_minor" bigint,
	"currency" varchar(3),
	"status" text DEFAULT 'open' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"assigned_to" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "alert_rule" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'expiry' NOT NULL,
	"threshold_days" integer,
	"severity" smallint DEFAULT 3 NOT NULL,
	"location_id" uuid,
	"category_id" uuid,
	"product_id" uuid,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '["in_app","email"]'::jsonb NOT NULL,
	"cadence" text DEFAULT 'daily_digest' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"template" varchar(64) NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"alert_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"action_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"destination" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"provider" varchar(32),
	"provider_message_id" varchar(128),
	"error_code" varchar(64),
	"error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_preference" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"min_severity" smallint DEFAULT 5 NOT NULL,
	"cadence" text DEFAULT 'daily_digest' NOT NULL,
	"digest_send_at" varchar(5) DEFAULT '08:00' NOT NULL,
	"quiet_hours_start" varchar(5),
	"quiet_hours_end" varchar(5),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"last_used_at" timestamp with time zone,
	"failure_count" smallint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dispense" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" bigint NOT NULL,
	"unit_price_minor" bigint,
	"currency" varchar(3),
	"was_fefo_compliant" boolean,
	"fefo_override_reason" text,
	"prescription_reference" varchar(64),
	"dispensed_by" uuid,
	"dispensed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "disposition" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"quantity" bigint NOT NULL,
	"cost_value_minor" bigint,
	"recovered_value_minor" bigint,
	"currency" varchar(3),
	"supplier_id" uuid,
	"credit_note_reference" varchar(64),
	"credit_received_at" timestamp with time zone,
	"certificate_reference" varchar(64),
	"witnessed_by" uuid,
	"alert_event_id" uuid,
	"proposed_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"reason" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "import_job" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"format" varchar(8) NOT NULL,
	"byte_size" integer,
	"content_hash" varchar(64),
	"storage_key" text,
	"column_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"valid_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"committed_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "import_row" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_job_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"normalized" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_demand_stat" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"window_days" smallint DEFAULT 90 NOT NULL,
	"units_dispensed" bigint DEFAULT 0 NOT NULL,
	"average_daily_demand_milli" integer DEFAULT 0 NOT NULL,
	"days_of_cover_remaining" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"expected_at" date,
	"submitted_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"subtotal_minor" bigint,
	"tax_minor" bigint,
	"total_minor" bigint,
	"currency" varchar(3),
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "purchase_order_line" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_ordered" bigint NOT NULL,
	"quantity_received" bigint DEFAULT 0 NOT NULL,
	"unit_cost_minor" bigint,
	"currency" varchar(3),
	"minimum_shelf_life_days" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recall" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid,
	"catalog_id" uuid,
	"reference" varchar(64) NOT NULL,
	"issued_by" varchar(32) NOT NULL,
	"classification" varchar(16),
	"title" text NOT NULL,
	"description" text,
	"affected_batch_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected_expiry_from" date,
	"affected_expiry_to" date,
	"status" text DEFAULT 'open' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"source_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "recall_batch" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"recall_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"quantity_affected" bigint,
	"status" text DEFAULT 'identified' NOT NULL,
	"actioned_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scan" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"image_key" text NOT NULL,
	"image_width" integer,
	"image_height" integer,
	"provider" varchar(32),
	"model" varchar(64),
	"extraction" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extracted_drug_name" text,
	"extracted_expiry_date" date,
	"extracted_batch_number" varchar(64),
	"confidence" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"corrected_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_batch_id" uuid,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" varchar(12) NOT NULL,
	"key_hash" varchar(128) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"rate_limit_per_minute" integer DEFAULT 120 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" varchar(48) NOT NULL,
	"entity_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" varchar(128) NOT NULL,
	"byte_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"checksum_sha256" varchar(64),
	"purpose" varchar(32),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid,
	"entity_type" varchar(48) NOT NULL,
	"entity_id" uuid,
	"action" varchar(32) NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" uuid,
	"actor_type" varchar(16) DEFAULT 'user' NOT NULL,
	"actor_label" text,
	"ip_address" varchar(45),
	"user_agent" text,
	"request_id" varchar(64),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(128) NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"response_status" smallint,
	"response_body" jsonb,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid,
	"job_name" varchar(64) NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "org_setting" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"namespace" varchar(32) NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"response_status" smallint,
	"response_body" text,
	"next_retry_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" uuid NOT NULL,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"signing_secret" varchar(128) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" smallint DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_app_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_location" ADD CONSTRAINT "membership_location_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_location" ADD CONSTRAINT "membership_location_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drug_catalog" ADD CONSTRAINT "drug_catalog_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_catalog_id_drug_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."drug_catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_category_id_product_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_base_uom_id_unit_of_measure_id_fk" FOREIGN KEY ("base_uom_id") REFERENCES "public"."unit_of_measure"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_purchase_uom_id_unit_of_measure_id_fk" FOREIGN KEY ("purchase_uom_id") REFERENCES "public"."unit_of_measure"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_category" ADD CONSTRAINT "product_category_parent_id_product_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."product_category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_location_setting" ADD CONSTRAINT "product_location_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_location_setting" ADD CONSTRAINT "product_location_setting_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_location_setting" ADD CONSTRAINT "product_location_setting_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supplier" ADD CONSTRAINT "product_supplier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supplier" ADD CONSTRAINT "product_supplier_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_supplier" ADD CONSTRAINT "product_supplier_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_applied_by_app_user_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_stock_count_id_stock_count_id_fk" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_count"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_counted_by_app_user_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_actor_id_app_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_from_location_id_location_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_to_location_id_location_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_stock_transfer_id_stock_transfer_id_fk" FOREIGN KEY ("stock_transfer_id") REFERENCES "public"."stock_transfer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_destination_batch_id_batch_id_fk" FOREIGN KEY ("destination_batch_id") REFERENCES "public"."batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_alert_rule_id_alert_rule_id_fk" FOREIGN KEY ("alert_rule_id") REFERENCES "public"."alert_rule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_acknowledged_by_app_user_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_assigned_to_app_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_category_id_product_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_app_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense" ADD CONSTRAINT "dispense_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense" ADD CONSTRAINT "dispense_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense" ADD CONSTRAINT "dispense_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense" ADD CONSTRAINT "dispense_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense" ADD CONSTRAINT "dispense_dispensed_by_app_user_id_fk" FOREIGN KEY ("dispensed_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_witnessed_by_app_user_id_fk" FOREIGN KEY ("witnessed_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_alert_event_id_alert_event_id_fk" FOREIGN KEY ("alert_event_id") REFERENCES "public"."alert_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_proposed_by_app_user_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disposition" ADD CONSTRAINT "disposition_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job" ADD CONSTRAINT "import_job_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_import_job_id_import_job_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_row" ADD CONSTRAINT "import_row_created_batch_id_batch_id_fk" FOREIGN KEY ("created_batch_id") REFERENCES "public"."batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_demand_stat" ADD CONSTRAINT "product_demand_stat_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_demand_stat" ADD CONSTRAINT "product_demand_stat_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_demand_stat" ADD CONSTRAINT "product_demand_stat_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall" ADD CONSTRAINT "recall_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall" ADD CONSTRAINT "recall_catalog_id_drug_catalog_id_fk" FOREIGN KEY ("catalog_id") REFERENCES "public"."drug_catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_batch" ADD CONSTRAINT "recall_batch_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_batch" ADD CONSTRAINT "recall_batch_recall_id_recall_id_fk" FOREIGN KEY ("recall_id") REFERENCES "public"."recall"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_batch" ADD CONSTRAINT "recall_batch_batch_id_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_reviewed_by_app_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_created_batch_id_batch_id_fk" FOREIGN KEY ("created_batch_id") REFERENCES "public"."batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_app_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_setting" ADD CONSTRAINT "org_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpoint_id_webhook_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user" USING btree ("email") WHERE "app_user"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_token_key" ON "invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitation_org_email_idx" ON "invitation" USING btree ("organization_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "location_org_code_key" ON "location" USING btree ("organization_id","code") WHERE "location"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "location_org_idx" ON "location" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_org_user_key" ON "membership" USING btree ("organization_id","user_id") WHERE "membership"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "membership_location_location_idx" ON "membership_location" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_key" ON "organization" USING btree ("slug") WHERE "organization"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "drug_catalog_generic_idx" ON "drug_catalog" USING btree ("generic_name");--> statement-breakpoint
CREATE INDEX "drug_catalog_org_idx" ON "drug_catalog" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drug_catalog_nafdac_key" ON "drug_catalog" USING btree ("nafdac_number") WHERE "drug_catalog"."nafdac_number" IS NOT NULL AND "drug_catalog"."organization_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "drug_catalog_gtin_key" ON "drug_catalog" USING btree ("gtin") WHERE "drug_catalog"."gtin" IS NOT NULL AND "drug_catalog"."organization_id" IS NULL;--> statement-breakpoint
CREATE INDEX "product_org_idx" ON "product" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "product_catalog_idx" ON "product" USING btree ("catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_org_sku_key" ON "product" USING btree ("organization_id","sku") WHERE "product"."sku" IS NOT NULL AND "product"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "product_name_trgm_idx" ON "product" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "product_category_org_name_key" ON "product_category" USING btree ("organization_id","name") WHERE "product_category"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_location_setting_key" ON "product_location_setting" USING btree ("product_id","location_id");--> statement-breakpoint
CREATE INDEX "product_location_setting_location_idx" ON "product_location_setting" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_supplier_key" ON "product_supplier" USING btree ("product_id","supplier_id");--> statement-breakpoint
CREATE INDEX "product_supplier_supplier_idx" ON "product_supplier" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_org_idx" ON "supplier" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_org_code_key" ON "supplier" USING btree ("organization_id","code") WHERE "supplier"."code" IS NOT NULL AND "supplier"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "unit_of_measure_org_code_key" ON "unit_of_measure" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "batch_expiry_scan_idx" ON "batch" USING btree ("organization_id","location_id","expiry_date") WHERE "batch"."status" = 'active' AND "batch"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "batch_product_idx" ON "batch" USING btree ("product_id","expiry_date");--> statement-breakpoint
CREATE INDEX "batch_location_idx" ON "batch" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "batch_supplier_idx" ON "batch" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_natural_key" ON "batch" USING btree ("location_id","product_id","batch_number","expiry_date") WHERE "batch"."batch_number" IS NOT NULL AND "batch"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_org_reference_key" ON "stock_count" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE INDEX "stock_count_location_idx" ON "stock_count" USING btree ("location_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_line_key" ON "stock_count_line" USING btree ("stock_count_id","batch_id");--> statement-breakpoint
CREATE INDEX "stock_count_line_batch_idx" ON "stock_count_line" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "stock_movement_batch_idx" ON "stock_movement" USING btree ("batch_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movement_org_time_idx" ON "stock_movement" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movement_product_idx" ON "stock_movement" USING btree ("product_id","occurred_at");--> statement-breakpoint
CREATE INDEX "stock_movement_reference_idx" ON "stock_movement" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfer_org_reference_key" ON "stock_transfer" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE INDEX "stock_transfer_from_idx" ON "stock_transfer" USING btree ("from_location_id","status");--> statement-breakpoint
CREATE INDEX "stock_transfer_to_idx" ON "stock_transfer" USING btree ("to_location_id","status");--> statement-breakpoint
CREATE INDEX "stock_transfer_line_transfer_idx" ON "stock_transfer_line" USING btree ("stock_transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_event_dedupe_key" ON "alert_event" USING btree ("alert_rule_id","batch_id") WHERE "alert_event"."batch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "alert_event_open_idx" ON "alert_event" USING btree ("organization_id","location_id","severity","fired_at") WHERE "alert_event"."status" = 'open';--> statement-breakpoint
CREATE INDEX "alert_event_batch_idx" ON "alert_event" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "alert_event_assigned_idx" ON "alert_event" USING btree ("assigned_to") WHERE "alert_event"."status" = 'open';--> statement-breakpoint
CREATE INDEX "alert_rule_org_kind_idx" ON "alert_rule" USING btree ("organization_id","kind") WHERE "alert_rule"."is_enabled" = true AND "alert_rule"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "alert_rule_product_idx" ON "alert_rule" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "alert_rule_category_idx" ON "alert_rule" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "notification_recipient_idx" ON "notification" USING btree ("recipient_user_id","created_at") WHERE "notification"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notification_org_idx" ON "notification" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_key" ON "notification_delivery" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "notification_delivery_retry_idx" ON "notification_delivery" USING btree ("next_retry_at") WHERE "notification_delivery"."status" IN ('queued','failed');--> statement-breakpoint
CREATE INDEX "notification_delivery_provider_idx" ON "notification_delivery" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preference_key" ON "notification_preference" USING btree ("organization_id","user_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscription_endpoint_key" ON "push_subscription" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscription_user_idx" ON "push_subscription" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dispense_org_time_idx" ON "dispense" USING btree ("organization_id","dispensed_at");--> statement-breakpoint
CREATE INDEX "dispense_batch_idx" ON "dispense" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "dispense_product_idx" ON "dispense" USING btree ("product_id","dispensed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "disposition_org_reference_key" ON "disposition" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE INDEX "disposition_batch_idx" ON "disposition" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "disposition_org_status_idx" ON "disposition" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "disposition_supplier_idx" ON "disposition" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "disposition_pending_credit_idx" ON "disposition" USING btree ("organization_id","supplier_id") WHERE "disposition"."action" = 'return_to_supplier' AND "disposition"."credit_received_at" IS NULL;--> statement-breakpoint
CREATE INDEX "import_job_org_status_idx" ON "import_job" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_row_key" ON "import_row" USING btree ("import_job_id","line_number");--> statement-breakpoint
CREATE INDEX "import_row_status_idx" ON "import_row" USING btree ("import_job_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "product_demand_stat_key" ON "product_demand_stat" USING btree ("location_id","product_id","window_days");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_org_reference_key" ON "purchase_order" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE INDEX "purchase_order_supplier_idx" ON "purchase_order" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "purchase_order_line_po_idx" ON "purchase_order_line" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "recall_org_status_idx" ON "recall" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "recall_catalog_idx" ON "recall" USING btree ("catalog_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recall_batch_key" ON "recall_batch" USING btree ("recall_id","batch_id");--> statement-breakpoint
CREATE INDEX "recall_batch_batch_idx" ON "recall_batch" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "scan_org_status_idx" ON "scan" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "scan_review_queue_idx" ON "scan" USING btree ("organization_id","created_at") WHERE "scan"."status" = 'needs_review';--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_hash_key" ON "api_key" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_key_org_idx" ON "api_key" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "attachment_entity_idx" ON "attachment" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "attachment_org_idx" ON "attachment" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_org_time_idx" ON "audit_log" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_key_unique" ON "idempotency_key" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_key_expiry_idx" ON "idempotency_key" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "job_run_name_time_idx" ON "job_run" USING btree ("job_name","started_at");--> statement-breakpoint
CREATE INDEX "job_run_org_idx" ON "job_run" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_setting_key" ON "org_setting" USING btree ("organization_id","namespace","key");--> statement-breakpoint
CREATE INDEX "webhook_delivery_endpoint_idx" ON "webhook_delivery" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_delivery_retry_idx" ON "webhook_delivery" USING btree ("next_retry_at") WHERE "webhook_delivery"."status" IN ('queued','failed');--> statement-breakpoint
CREATE INDEX "webhook_endpoint_org_idx" ON "webhook_endpoint" USING btree ("organization_id");