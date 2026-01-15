DROP INDEX "violations_unique_active_user_session_type";--> statement-breakpoint
ALTER TABLE "violations" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "server_users_last_activity_idx" ON "server_users" USING btree ("last_activity_at");--> statement-breakpoint
CREATE INDEX "violations_inactivity_dedup_idx" ON "violations" USING btree ("server_user_id","rule_id","acknowledged_at");--> statement-breakpoint
CREATE UNIQUE INDEX "violations_unique_active_user_session_type" ON "violations" USING btree ("server_user_id","session_id","rule_type") WHERE "violations"."acknowledged_at" IS NULL AND "violations"."session_id" IS NOT NULL;