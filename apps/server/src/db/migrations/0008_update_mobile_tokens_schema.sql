-- Custom SQL migration file, put your code below! --

-- Update mobile_tokens schema for one-time pairing tokens
-- Remove old columns (is_enabled, rotated_at) and add new columns (expires_at, created_by, used_at)

-- Step 1: Clear existing tokens (breaking change - old schema incompatible)
DELETE FROM "mobile_tokens";

-- Step 2: Drop old columns
ALTER TABLE "mobile_tokens" DROP COLUMN IF EXISTS "is_enabled";
ALTER TABLE "mobile_tokens" DROP COLUMN IF EXISTS "rotated_at";

-- Step 3: Add new required column with temporary default
ALTER TABLE "mobile_tokens" ADD COLUMN "expires_at" timestamp with time zone NOT NULL DEFAULT NOW() + INTERVAL '15 minutes';

-- Step 4: Add nullable columns
ALTER TABLE "mobile_tokens" ADD COLUMN "created_by" uuid;
ALTER TABLE "mobile_tokens" ADD COLUMN "used_at" timestamp with time zone;

-- Step 5: Add foreign key constraint
ALTER TABLE "mobile_tokens" ADD CONSTRAINT "mobile_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Step 6: Remove temporary default from expires_at
ALTER TABLE "mobile_tokens" ALTER COLUMN "expires_at" DROP DEFAULT;
