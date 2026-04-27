---
name: migrate-database
description: Use when migrating PostgreSQL schema and data (including RLS policies, triggers, enum types, and functions) from a Supabase project to InsForge. Diagnoses target model first (modern auth.users vs legacy _accounts), applies minimal transforms, and loads via direct psql (bypassing InsForge's restrictive import API).
---

# Migrate Database (Supabase → modern InsForge)

## When to invoke

- Orchestrator dispatched to this skill
- User wants schema + data migrated; not a one-off table
- Target is **modern InsForge** (has `auth.users` schema — verified by orchestrator probe)

## When NOT to invoke

- Legacy InsForge target (`_accounts` instead of `auth.users`) → use github.com/InsForge/supabase-to-insforge reference toolkit unchanged
- Realtime migration, edge functions → other skills / manual
- Target public schema is non-empty → coordinate drop/merge with user first

## Inputs required

```
SUPABASE_DB_URL       # postgresql://postgres.<ref>:<pw>@<pooler>:6543/postgres  (read)
INSFORGE_DB_URL       # postgresql://postgres:<pw>@<host>:5432/insforge?sslmode=require  (write)
```

## Diagnostic probe (ALWAYS run first — decides strategy)

```bash
export PGPASSWORD='<insforge-password>'
psql "$INSFORGE_DB_URL" -c "
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='auth' AND table_name='users') AS has_auth_users,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='auth' AND p.proname='uid') AS has_auth_uid,
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS existing_public_tables,
  (SELECT count(*) FROM pg_extension WHERE extname='pgcrypto') AS has_pgcrypto;
"
```

**Expected output for this skill's happy path:** `has_auth_users=1`, `has_auth_uid=1`, `existing_public_tables=0`, `has_pgcrypto=1`.

If `existing_public_tables > 0`: stop, ask the user if this target should be wiped or if tables should be merged. Running this skill against a non-empty target will fail.

## Migration delivery: `db migrations` register, don't direct-psql

Earlier guidance in this skill shows applying the transformed SQL via `psql -f insforge-ready.sql`. That works, but **the preferred path is `npx @insforge/cli db migrations`** so the schema is registered as a tracked baseline and future schema changes chain from a known state. Confirmed against modern InsForge on the wdabt trial (2026-04-26):

```bash
mkdir -p migrations
TS=$(date -u +%Y%m%d%H%M%S)
cp insforge-ready.sql "migrations/${TS}_baseline-from-supabase.sql"
# ensure .insforge/project.json points at the right project, then:
npx @insforge/cli db migrations up --all
```

InsForge's migration runner wraps each file in a backend-managed transaction — do not put `BEGIN`/`COMMIT`/`ROLLBACK` in the SQL. The transform script already complies.

If you must direct-psql (e.g., to bootstrap before the project is linked), the dry-run check is:

```bash
psql "$INSFORGE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -c "BEGIN;" -f insforge-ready.sql -c "ROLLBACK;"
```

A clean dry-run prints `ROLLBACK` at the end with `WARNING:  there is no transaction in progress` — the transaction was rolled back successfully.

## Procedure

### 1. Dump source schema

```bash
pg_dump "$SUPABASE_DB_URL" \
  --schema=public \
  --schema-only \
  --no-owner --no-privileges \
  --no-publications --no-subscriptions \
  -f supabase-schema.sql
```

Verify: `wc -l supabase-schema.sql` is > 1000 lines typical. `grep -c '^CREATE TABLE' supabase-schema.sql` = your table count.

### 2. Apply transforms

Use the companion `transform.sh` in this skill directory. It applies:

1. Strip `SET` statements (InsForge's Postgres rejects `transaction_timeout`)
2. Strip `COMMENT ON` (can fail on unknown objects)
3. Strip `CREATE SCHEMA public` (already exists on target)
4. Rewrite `service_role` → `project_admin` (InsForge's admin role)
5. Qualify `extensions.gen_random_bytes` → `public.gen_random_bytes` (pgcrypto lives in `public` on InsForge, not `extensions`)
6. Qualify `extensions.uuid_generate_v4` → `public.gen_random_uuid` (uuid-ossp not installed; pgcrypto's gen_random_uuid is the replacement)
7. **Move `CREATE FUNCTION` blocks before `CREATE TRIGGER` and `CREATE POLICY`** — pg_dump emits functions first but triggers/policies reference them
8. Set `search_path = public, pg_catalog` explicitly at file start
9. Append one admin bypass policy per RLS table: `CREATE POLICY "project_admin_all_<t>" ON public.<t> TO "project_admin" USING (true) WITH CHECK (true);` — InsForge's project_admin is subject to RLS (unlike Supabase service_role)

Run:

```bash
./transform.sh supabase-schema.sql insforge-ready.sql
```

Expected output: `Transform complete: N lines → insforge-ready.sql` + `RLS tables covered: M`.

### 3. Prepare target (if starting fresh)

**WARNING:** `DROP SCHEMA public CASCADE` also drops your extensions and all role grants. If target is fresh, use this sequence. If target has other data you want preserved, you cannot run this — ask user.

```bash
export PGPASSWORD='<insforge-password>'
psql "$INSFORGE_DB_URL" <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
-- Re-install extensions that lived in public
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA public;
-- CRITICAL: restore role grants that DROP SCHEMA wiped
GRANT USAGE ON SCHEMA public TO anon, authenticated, project_admin;
GRANT ALL ON SCHEMA public TO postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO project_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO project_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO project_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
SQL
```

### 4. Apply schema

```bash
psql "$INSFORGE_DB_URL" -v ON_ERROR_STOP=0 -f insforge-ready.sql 2>&1 | tee apply.log
grep -c ERROR apply.log
```

Expected on a successful run against a fresh target: **0 errors**. If > 0, inspect the first error — almost always a transform gap not yet captured here.

### 5. Grant access to existing tables (after CREATE TABLE ran)

After step 4, run grants again to cover the newly-created tables:

```bash
psql "$INSFORGE_DB_URL" <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO project_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO project_admin;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO project_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
SQL
```

### 6. Dump source data

```bash
pg_dump "$SUPABASE_DB_URL" \
  --schema=public \
  --data-only \
  --no-owner --no-privileges \
  --disable-triggers \
  -f supabase-data.sql
```

`--disable-triggers` is essential — otherwise `updated_at` triggers rewrite timestamps as data loads.

### 7. Apply data

```bash
psql "$INSFORGE_DB_URL" -v ON_ERROR_STOP=0 -f supabase-data.sql 2>&1 | tee data.log
grep -c ERROR data.log
```

Expected: 1 error at the top (`unrecognized configuration parameter "transaction_timeout"`) — benign, a SET statement pg_dump emitted that InsForge's Postgres doesn't support. All COPY statements should succeed.

**NOTE on FK failures:** if you haven't run `migrate-auth` first and a public table has a *defined* FK to `auth.users` (this source had none — check yours), those rows will fail. Run `migrate-auth` first, then rerun this data load.

## Verification

```bash
psql "$INSFORGE_DB_URL" <<'SQL'
\echo === object counts ===
SELECT 'tables' AS kind, count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
UNION ALL SELECT 'enums', count(*) FROM pg_type t JOIN pg_namespace n ON t.typnamespace=n.oid WHERE n.nspname='public' AND typtype='e'
UNION ALL SELECT 'functions', count(*) FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.prokind='f'
UNION ALL SELECT 'triggers', count(*) FROM information_schema.triggers WHERE trigger_schema='public'
UNION ALL SELECT 'policies (all)', count(*) FROM pg_policies WHERE schemaname='public'
UNION ALL SELECT 'policies (admin bypass)', count(*) FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'project_admin_all_%';
\echo === top tables by row count ===
SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY n_live_tup DESC LIMIT 10;
SQL
```

Compare each count to your source probe. Admin bypass policy count should equal source RLS-enabled table count.

## Common pitfalls (from trial 2026-04-13 against real source)

### CRITICAL: reload PostgREST schema cache after schema changes (opendata 2026-04-15)

After running `CREATE TABLE` / `ALTER TABLE ADD FOREIGN KEY` etc., PostgREST's in-memory schema cache is **stale**. SDK calls like:

```typescript
insforge.database.from('org_members').select('*, organizations(id, name, slug)')
```

will fail with:

```
{"code":"PGRST200","message":"Could not find a relationship between 'org_members' and 'organizations' in the schema cache"}
```

even though the FK constraint exists in Postgres. **Mandatory fix** — run this immediately after every schema migration:

```bash
psql "$INSFORGE_DB_URL" -c "NOTIFY pgrst, 'reload schema';"
```

This notifies PostgREST (listening via LISTEN pgrst) to rebuild its cache. Wait ~2 seconds after before hitting the REST API. Add this to the end of your migration runner; missing it makes `.select('*, relation(...)')` silently fail on freshly-migrated tables.

### Other pitfalls

- **pg_dump v17 emits `\restrict` / `\unrestrict` psql meta-commands and `SELECT pg_catalog.set_config('search_path', '', false);`** (wdabt trial, 2026-04-26). These are valid when applied via `psql` but the InsForge `db migrations` runner is the backend, not psql — `\restrict` is unrecognized, and `set_config(...,'',false)` clears the explicit `SET search_path = public, pg_catalog` that the transform prepends, breaking unqualified function references inside policies and triggers. Transform strips all three.
- **`transaction_timeout` config unknown** — benign, pg_dump emits `SET transaction_timeout=0` which InsForge's Postgres version doesn't recognize. Transform strips `^SET `.
- **`schema public already exists`** — pg_dump emits `CREATE SCHEMA public`. Transform strips it.
- **`function gen_random_bytes(integer) does not exist`** during `CREATE TABLE` with `DEFAULT encode(gen_random_bytes(32), 'hex')`** — source qualified as `extensions.gen_random_bytes`. InsForge has pgcrypto in `public`, not `extensions`. Transform rewrites to `public.gen_random_bytes`. Without explicit schema qualifier, search_path resolution during DDL context fails even though `pgcrypto` is installed.
- **`relation "public.X" does not exist`** when creating a CONSTRAINT or INDEX on it — means the `CREATE TABLE public.X` earlier failed. Scroll up in apply.log for the root cause.
- **`function public.Y() does not exist`** during `CREATE TRIGGER` — you didn't move functions before triggers. Transform handles this via awk extraction + reinjection before first `CREATE TRIGGER` or `CREATE POLICY`.
- **`permission denied for schema public`** via HTTP API after a DROP+CREATE — you wiped the grants. Run the grant block in Step 3.
- **Row counts appear stale in `pg_stat_user_tables`** — use `SELECT count(*) FROM <table>` for an authoritative count.
- **`auth.users` is populated but public.X FK violations** — you ran data load before auth migration. Re-run data load after migrate-auth.
- **No FK from public.* → auth.users found in dump** — common pattern: apps FK to their own `app_profiles.id`, which soft-references `auth.users.id` via a non-FK column. Verify the link still holds: `SELECT count(*) FROM app_profiles ap WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = ap.user_id);` → should be 0.

## Scope boundary

Does not cover: auth users (use `migrate-auth`), storage objects (use `migrate-storage`), realtime publications, vault secrets, MFA tables, SSO/SAML tables, pg_graphql. All of those are out of scope — flagged by orchestrator.
