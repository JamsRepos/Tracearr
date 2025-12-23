-- Optimize sessions_active_lookup_idx to be a covering index
-- This avoids heap lookups during the polling hot path (every 15s per server)
-- Columns included cover the SELECT list in findActiveSessions queries

DROP INDEX IF EXISTS "sessions_active_lookup_idx";

CREATE INDEX "sessions_active_lookup_idx" ON "sessions"
USING btree ("server_id", "session_key", "stopped_at")
INCLUDE ("state", "started_at", "server_user_id", "rating_key", "external_session_id");
