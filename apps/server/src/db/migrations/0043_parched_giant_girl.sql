CREATE TABLE "library_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"library_id" varchar(100) NOT NULL,
	"library_name" varchar(255) NOT NULL,
	"library_type" varchar(50) NOT NULL,
	"snapshot_date" timestamp NOT NULL,
	"total_items" integer NOT NULL,
	"total_size_bytes" bigint NOT NULL,
	"total_duration_ms" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_snapshots_unique" UNIQUE("server_id","library_id","snapshot_date")
);
--> statement-breakpoint
CREATE TABLE "library_statistics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"library_id" varchar(100) NOT NULL,
	"library_name" varchar(255) NOT NULL,
	"library_type" varchar(50) NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"total_episodes" integer,
	"total_seasons" integer,
	"total_shows" integer,
	"total_size_bytes" bigint DEFAULT 0 NOT NULL,
	"total_duration_ms" bigint DEFAULT 0 NOT NULL,
	"avg_file_size_bytes" bigint,
	"avg_duration_ms" bigint,
	"avg_bitrate_kbps" integer,
	"hdr_item_count" integer DEFAULT 0,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_statistics_unique" UNIQUE("server_id","library_id")
);
--> statement-breakpoint
ALTER TABLE "library_snapshots" ADD CONSTRAINT "library_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_statistics" ADD CONSTRAINT "library_statistics_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_snapshots_server_date_idx" ON "library_snapshots" USING btree ("server_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "library_snapshots_library_date_idx" ON "library_snapshots" USING btree ("server_id","library_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "library_statistics_server_idx" ON "library_statistics" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "library_statistics_last_updated_idx" ON "library_statistics" USING btree ("last_updated_at");