ALTER TABLE "sessions"
ADD COLUMN "geo_continent" varchar(100);

ALTER TABLE "sessions"
ADD COLUMN "geo_postal" varchar(20);

ALTER TABLE "sessions"
ADD COLUMN "geo_asn_number" integer;

ALTER TABLE "sessions"
ADD COLUMN "geo_asn_organization" varchar(255);
