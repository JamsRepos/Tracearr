ALTER TABLE "servers" ADD COLUMN "display_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "servers_display_order_idx" ON "servers" USING btree ("display_order");--> statement-breakpoint

-- Backfill display_order for existing servers based on created_at (oldest = 0, newest = N-1)
WITH ordered_servers AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) - 1 as new_order
  FROM servers
)
UPDATE servers
SET display_order = ordered_servers.new_order
FROM ordered_servers
WHERE servers.id = ordered_servers.id;