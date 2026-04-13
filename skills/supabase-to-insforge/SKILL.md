---
name: supabase-to-insforge
description: Use when a user wants to migrate an application from Supabase to InsForge. Orchestrates database, auth, storage, edge function, and frontend SDK migration. Runs a diagnostic probe first, produces an inventory report, selects strategy based on the target's actual schema shape, then dispatches to child skills in dependency order.
---

# Supabase → InsForge Migration Orchestrator

## When to invoke

- User asks to migrate a Supabase project/app to InsForge
- User asks "how do I move off Supabase"
- User gives you source Supabase creds + target InsForge creds and asks to migrate data

## When NOT to invoke

- User only wants to change the frontend SDK without moving data → use `migrate-frontend-sdk` directly
- User only wants to port RLS policies between two Postgres databases without moving platforms → this skill is overkill
- User is doing the reverse direction (InsForge → Supabase) → not supported

## Inputs required

From the user, gather BEFORE starting:

```
Source (Supabase):
  SUPABASE_DB_URL                 # postgresql://postgres.<ref>:<pw>@<pooler>:6543/postgres  (read access minimum)
  SUPABASE_URL                    # https://<ref>.supabase.co                                (for storage public URLs)
  SUPABASE_SERVICE_ROLE_KEY       # required ONLY for private-bucket object download

Target (InsForge):
  INSFORGE_DB_URL                 # postgresql://postgres:<pw>@<host>:5432/insforge?sslmode=require  (write access)
  INSFORGE_API_URL                # e.g., https://<host>.insforge.app  (for storage object uploads)
  INSFORGE_API_KEY                # project_admin API key              (for storage HTTP PUTs)

Frontend (optional, only if doing SDK rewrite):
  Path to the frontend repo that uses @supabase/supabase-js
```

## Step 1 — Diagnostic probe

Run these two probes verbatim BEFORE making any changes. Their output decides strategy.

### Probe source

```bash
export PGPASSWORD='<supabase-password>'
psql "postgresql://postgres.<ref>@<pooler>:6543/postgres" <<'SQL'
\echo === schemas ===
SELECT schema_name FROM information_schema.schemata
  WHERE schema_name IN ('public','auth','storage','realtime','vault','graphql_public') ORDER BY 1;
\echo === public tables + row counts ===
SELECT relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY n_live_tup DESC;
\echo === RLS policies per table ===
SELECT tablename, count(*) FROM pg_policies WHERE schemaname='public' GROUP BY 1 ORDER BY 1;
\echo === auth users ===
SELECT count(*) FROM auth.users;
\echo === storage buckets ===
SELECT name, public FROM storage.buckets;
\echo === storage object counts by bucket ===
SELECT bucket_id, count(*) FROM storage.objects GROUP BY bucket_id;
\echo === enum types ===
SELECT typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace=n.oid WHERE n.nspname='public' AND typtype='e' ORDER BY 1;
\echo === extensions ===
SELECT extname FROM pg_extension ORDER BY 1;
\echo === functions in public ===
SELECT proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.prokind='f' ORDER BY 1;
\echo === identities by provider ===
SELECT provider, count(*) FROM auth.identities GROUP BY provider;
SQL
```

### Probe target

```bash
export PGPASSWORD='<insforge-password>'
psql "postgresql://postgres@<host>:5432/insforge?sslmode=require" <<'SQL'
\echo === target schemas ===
SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' ORDER BY 1;
\echo === is this modern InsForge? ===
SELECT (count(*) FILTER (WHERE table_schema='auth' AND table_name='users') > 0) AS has_auth_users,
       (count(*) FILTER (WHERE table_schema='public' AND table_name='_accounts') > 0) AS has_legacy_accounts,
       (count(*) FILTER (WHERE table_schema='storage' AND table_name='objects') > 0) AS has_storage_objects
FROM information_schema.tables;
\echo === auth helper functions ===
SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
  WHERE p.proname IN ('uid','role','jwt','email') ORDER BY 1,2;
\echo === roles (should include anon, authenticated, project_admin) ===
SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','project_admin','service_role') ORDER BY 1;
\echo === existing public tables (is target empty?) ===
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1;
SQL
```

## Step 2 — Decide strategy from probe output

| Probe finding | Strategy |
|---|---|
| Target: `has_auth_users=t`, `has_legacy_accounts=f`, `has_storage_objects=t` | **Modern InsForge** — use child skills as written |
| Target: `has_auth_users=f`, `has_legacy_accounts=t` | **Legacy InsForge** — use the reference toolkit (github.com/InsForge/supabase-to-insforge) unchanged |
| Target: has both or neither | STOP — unusual state; surface to user before proceeding |
| Target public schema has user tables | STOP — target is not empty; ask user whether to drop or merge |
| Target lacks `authenticated` role | STOP — not a valid InsForge instance |

All the child skills below assume **modern InsForge**. For legacy, redirect to the reference repo.

## Step 3 — Produce inventory report

Print this to the user, filled from probe output:

```
Source summary:
  - N public tables, N RLS policies total
  - N auth users, N auth identities (providers: ...)
  - N storage buckets: <name> (public/private, N objects), ...
  - N enum types
  - N user-defined functions in public
  - Extensions: ...

Target summary:
  - Modern InsForge (has auth.users, storage.objects)
  - auth.uid/role/email helpers all present
  - Empty public schema: yes/no
  - N existing buckets: ...

Not migrating (documented as manual follow-up):
  - Realtime: N subscription/channel uses → manual rewrite
  - Vault secrets: N rows → manual re-entry
  - MFA factors / SSO / SAML if present → not supported in InsForge core
  - pg_graphql queries in frontend → rewrite to PostgREST/SDK
```

## Step 4 — Dispatch to child skills in order

Execute in this exact order. Each step depends on the previous.

1. **migrate-database** — schema only first, then data (skip if target public isn't empty — ask user)
2. **migrate-auth** — users must exist before any public data load completes successfully (FK-reliant tables)
3. **migrate-storage** — buckets first (SQL), then objects (HTTP API), then URL rewrite in jsonb columns
4. **migrate-edge-functions** — optional; requires source repo path to find `supabase/functions/*/index.ts`
5. **migrate-frontend-sdk** — optional; last step, points the app at InsForge

Wait for user confirmation between steps. Each child skill has its own verification queries — run them.

## Step 5 — Post-migration checklist

Print this to the user after Step 4 completes:

```
[ ] All users can log in with original passwords (spot-check 2-3)
[ ] Row counts match source for every table (use the verify SQL in migrate-database)
[ ] RLS policies return expected rows for a logged-in test user
[ ] Storage objects load in browser for sampled keys
[ ] No supabase.co URLs remain in DB (grep + verify SQL in migrate-storage)
[ ] App boots with new env vars (INSFORGE_API_URL, INSFORGE_API_KEY, no SUPABASE_*)
[ ] Edge functions respond (curl each function URL)
[ ] Realtime: manual rewrite of any supabase.channel() usage (out of scope)
[ ] Vault: manual re-entry of secrets into system.secrets (out of scope)
[ ] MFA/SSO/SAML (if used): out of scope — rebuild in InsForge auth config
```

## Scope boundary

Orchestration only — never modifies data, only dispatches. The orchestrator is stateless between invocations. Produces a report, recommends order, hands off. Child skills do the actual work.

## Common pitfalls (from trial migration 2026-04-13)

- **Wrong MCP instance**: The `mcp__insforge__*` tools may point at a different InsForge project than the one the user gave you DB credentials for. Use **raw psql + HTTP with the user-provided URL/key**, not MCP, unless the user confirms MCP and the target match.
- **Treating reference repo as current**: The github.com/InsForge/supabase-to-insforge repo assumes legacy schema (`_accounts`, `_storage`). Against modern InsForge (which your probe detects), its auth.users→_accounts and auth.uid()→uid() transforms are **wrong**. Use child skills instead.
- **Forgetting to capture source state first**: Don't start the trial before the source probe completes — you lose the comparison baseline.
- **Not asking about service role key early**: private buckets (most real apps have them) can't be exported without `SUPABASE_SERVICE_ROLE_KEY`. Ask up front.
