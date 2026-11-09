-- Generated from Better Auth 1.7.18 with the committed auth-options.mjs.
-- Reviewed SQL; application startup must never auto-run migrations.
create schema if not exists "scope_identity";

create table "scope_identity"."users" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "email_verified" boolean not null, "image" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create table "scope_identity"."sessions" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expires_at" timestamptz not null, "token" text not null unique, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null, "ip_address" text, "user_agent" text, "user_id" uuid not null references "scope_identity"."users" ("id") on delete cascade, "scope_epoch" text not null);

create table "scope_identity"."accounts" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "provider_subject" text not null, "provider_id" text not null, "user_id" uuid not null references "scope_identity"."users" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" timestamptz, "refresh_token_expires_at" timestamptz, "scope" text, "password" text, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz not null);

create table "scope_identity"."verifications" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expires_at" timestamptz not null, "created_at" timestamptz default CURRENT_TIMESTAMP not null, "updated_at" timestamptz default CURRENT_TIMESTAMP not null);

create table "scope_identity"."rate_limits" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "key" text not null unique, "count" integer not null, "last_request" bigint not null);

create index "sessions_user_id_idx" on "scope_identity"."sessions" ("user_id");

create index "accounts_user_id_idx" on "scope_identity"."accounts" ("user_id");

create index "verifications_identifier_idx" on "scope_identity"."verifications" ("identifier");
