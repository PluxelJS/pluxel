CREATE TABLE "billing_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"model" text,
	"unit_name" text NOT NULL,
	"unit_cost_cny" double precision NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"at" bigint NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"plugin_id" text NOT NULL,
	"operation" text NOT NULL,
	"model" text,
	"ok" boolean NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"input_bytes" integer NOT NULL,
	"output_bytes" integer NOT NULL,
	"units" double precision NOT NULL,
	"unit_name" text NOT NULL,
	"cost_cny" double precision NOT NULL,
	"currency" text NOT NULL,
	"cost_estimated" boolean NOT NULL,
	"upstream_request_id" text,
	"metadata_json" text
);
--> statement-breakpoint
CREATE TABLE "gateway_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_preview" text NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "provider_call_history" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_record_id" text NOT NULL,
	"at" bigint NOT NULL,
	"source" text NOT NULL,
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"model" text,
	"ok" boolean NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer NOT NULL,
	"input_bytes" integer NOT NULL,
	"output_bytes" integer NOT NULL,
	"upstream_request_id" text,
	"request_preview" text,
	"response_preview" text,
	"error" text,
	"details_json" text
);
--> statement-breakpoint
CREATE TABLE "workbench_projections" (
	"resource" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"position" integer NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workbench_projections_resource_id_pk" PRIMARY KEY("resource","id")
);
--> statement-breakpoint
CREATE TABLE "yiqicha_response_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"api_code" text NOT NULL,
	"api_key" text NOT NULL,
	"params_json" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer NOT NULL,
	"content_type" text NOT NULL,
	"body_text" text NOT NULL,
	"output_bytes" integer NOT NULL,
	"upstream_request_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_hit_at" bigint,
	"hit_count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_billing_usage_records_at" ON "billing_usage_records" USING btree ("at");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_records_provider_operation_at" ON "billing_usage_records" USING btree ("provider","operation","at");--> statement-breakpoint
CREATE INDEX "idx_billing_usage_records_user_at" ON "billing_usage_records" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "idx_provider_call_history_provider_at" ON "provider_call_history" USING btree ("provider","at");--> statement-breakpoint
CREATE INDEX "idx_provider_call_history_provider_record" ON "provider_call_history" USING btree ("provider","provider_record_id");--> statement-breakpoint
CREATE INDEX "workbench_projections_resource_position_idx" ON "workbench_projections" USING btree ("resource","position");--> statement-breakpoint
CREATE INDEX "idx_yiqicha_response_cache_api_code" ON "yiqicha_response_cache" USING btree ("api_code");--> statement-breakpoint
CREATE INDEX "idx_yiqicha_response_cache_last_hit_at" ON "yiqicha_response_cache" USING btree ("last_hit_at");--> statement-breakpoint
CREATE INDEX "idx_yiqicha_response_cache_updated_at" ON "yiqicha_response_cache" USING btree ("updated_at");