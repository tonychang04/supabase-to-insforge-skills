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

## Step 0 — Ask the user for these inputs BEFORE doing anything

**STOP**. Do not probe, dump, or write any files until you have all the required values. Ask the user for everything in one block; re-ask for anything they omit.

### Required (blocking)

| Ask for | Where user gets it | What it unlocks | Example |
|---|---|---|---|
| `SUPABASE_DB_URL` | Supabase → Project Settings → Database → Connection string → **Transaction pooler** | everything on source side | `postgresql://postgres.<ref>:<pw>@<region>.pooler.supabase.com:6543/postgres` |
| `INSFORGE_DB_URL` | InsForge → Settings → Database → Connection string (direct) | writing target schema + data | `postgresql://postgres:<pw>@<host>:5432/insforge?sslmode=require` |
| `INSFORGE_BASE_URL` | InsForge → Project → Overview → Project URL | storage uploads, function deploys, frontend SDK | `https://<app-key>.<region>.insforge.app` |
| `INSFORGE_API_KEY` | InsForge → Settings → API → **API Key** (starts with `ik_`) | admin HTTP operations | `ik_...` |
| `INSFORGE_ANON_KEY` | InsForge → Settings → API → **Anon Key** (JWT) | public frontend client | `eyJhbGc...` |

### Conditional (ask only if relevant to user's scope)

| Ask for | Needed when | Without it, what's blocked |
|---|---|---|
| `SUPABASE_URL` (https://\<ref\>.supabase.co) | migrating storage | public-bucket object downloads |
| `SUPABASE_SERVICE_ROLE_KEY` | migrating storage AND any bucket is private | private-bucket object downloads (auth required) |
| Frontend repo path | rewriting `@supabase/supabase-js` call sites | `migrate-frontend-sdk` skill |
| Edge-functions directory path (typically `<repo>/supabase/functions/`) | migrating edge functions | `migrate-edge-functions` skill |

### Ask proactively — user may not realize these matter

- "What layers are in scope — database / auth / storage / edge functions / frontend SDK / all?" (scopes the work)
- "Does your Supabase project have edge functions? Source can live on Supabase's runtime and NOT in the repo. Run `supabase functions list --project-ref <ref>` to confirm." (hidden functions get missed otherwise)
- "Do you use `supabase.channel()` / presence / broadcast realtime?" (does NOT auto-port)
- "Do you use `supabase.auth.admin.createSession` or similar admin-scope auth APIs (e.g., SSO callbacks)?" (no direct InsForge equivalent)
- "Do you use Supabase Vault (`vault.secrets`)?" (manual re-entry only)
- "Any MFA / SAML / SSO configured?" (re-configure manually on InsForge)

### Do NOT ask — already discoverable

- Table list, row counts, enum list, bucket names — the Step 1 probe surfaces these
- RLS policy bodies — `pg_dump` captures them verbatim
- User passwords (other than for manual login testing) — bcrypt hashes migrate byte-for-byte
- Supabase JWT secret — InsForge re-signs; old secret is useless

### Exact prompt to paraphrase to the user

> Before I start, I need a few things from your InsForge and Supabase dashboards — paste them all in one message:
>
> **From Supabase:**
> 1. Database connection string (Project Settings → Database → **Transaction pooler**)
> 2. Project URL (`https://<ref>.supabase.co`)
> 3. Service role key — **only if you have private storage buckets**
>
> **From InsForge:**
> 4. Database connection string (Settings → Database)
> 5. Project URL (`https://<app-key>.<region>.insforge.app`)
> 6. API key (starts with `ik_`)
> 7. Anon key (JWT — only if I'll be rewriting a frontend repo)
>
> **And tell me:**
> - What you want migrated (database / auth / storage / edge functions / frontend SDK / all)
> - Whether your app uses `supabase.channel()` realtime, `supabase.auth.admin.*` admin APIs, or Supabase Vault — these don't auto-port.

Wait for the full response. If a conditional item is missing, ask whether that layer is in scope before proceeding.

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

---

## Verified migration archetype #2 — Drizzle-ORM app (opendata, 2026-04-15)

Second migration trial: https://github.com/JaehoonSon/opendata (Jaehoon's Agentic Hyperpersonalization Platform → InsForge `hb42d4y3`). Profile:

- **Data access** through Drizzle ORM (not Supabase REST)
- **Source DB** 12 tables, 0 rows (greenfield), 13 RLS policies, `handle_new_user` trigger on `auth.users`
- **Source storage** 0 buckets — migrate-storage not invoked
- **Source edge functions** 0 deployed, no `supabase/functions/` dir — migrate-edge-functions not invoked
- **Call sites** 7 total, all `supabase.auth.*` (no `.from()`, `.storage.`, `.functions.`, `.channel()`)
- **Build result** `pnpm --filter web build` passes; `curl /onboard` with access cookie renders the authed page with the user's org slug

**Key finding that separates this archetype from the stet archetype:**

> When the app uses an ORM (Drizzle, Prisma, Kysely) that connects directly to Postgres, the `migrate-frontend-sdk` skill only touches the **auth** surface. `.database.from(...)` rewrites (the 92-site AST work on stet) are unnecessary — ORM queries stay unchanged. This is qualitatively 5–10× less work.

**Trigger to recognize this archetype during Step 0 probing:** if `grep -rlE "from ['\"]@supabase/supabase-js" | grep -v lib/supabase/` returns 0 files OR all hits are in the client setup modules only, and `package.json` includes a Postgres ORM (`drizzle-orm`, `prisma`, `kysely`, `@prisma/client`), inform the user this will be a much smaller migration than a typical `supabase-js`-everywhere app.

Two new pitfalls captured from opendata (both added to migrate-frontend-sdk/SKILL.md):

1. **Canonical InsForge SSR pattern** uses `isServerMode: true` + `edgeFunctionToken: accessToken` and **TWO app-managed cookies** (`insforge_access_token` 15m + `insforge_refresh_token` 7d). Earlier stet-era assumptions about a single SDK-managed cookie were superseded.
2. **OAuth callback param is `insforge_code`** (not `code`). Old Supabase-style `?code=xxx` parsing silently fails.

Also: **modern InsForge auto-attaches `project_admin_policy TO project_admin USING (true) WITH CHECK (true)` on every RLS-enabled table.** The reference repo's admin-policy-injection logic is redundant on modern targets (still correct on legacy).

---

## Verified migration archetype #3 — pg_cron + vault + realtime worker app (wdabt, 2026-04-26)

Third migration trial: https://github.com/monid-ai/what-did-agents-buy-today (Nuxt 4 dashboard for x402 settlements → InsForge `jbv4sa6j`). Profile:

- **Stack**: Nuxt 4 + `@nuxtjs/supabase` (client) + `@supabase/supabase-js` (server, service-role) + Vercel AI SDK + Vercel deployment
- **Source DB**: 10 public tables (`feed` 138K rows, `x402_services` 1218 rows, `queue`, `ingest`, `analytics_kv`, `x402_sync_state` + 4 unused), 3 views, 3 user functions, 5 RLS policies, **0 auth users**, **0 storage buckets**, **0 enums**
- **Heavy use of Supabase-only DB extensions**: `pg_cron` (5 active schedules calling worker endpoints), `pg_net` (HTTP from triggers/cron), `supabase_vault` (3 named secrets — `vercel_url`, `worker_secret`, `x402_webhook_url`), `supabase_realtime` publication on `feed` table
- **No auth, no storage** — drops migrate-auth and migrate-storage entirely

**Key finding that separates this archetype:**

> When the source app's "business logic" lives in `pg_cron` jobs and `vault` secrets driving HTTP callbacks to worker endpoints, **`pg_dump --schema=public` captures none of it**. The cron schedules live in `cron.job`, secrets in `vault.secrets`, the publication in `pg_publication_rel` — none in `public`. These need parallel, non-SQL migration:
>
> | Source artifact | Target equivalent | Migration command |
> |---|---|---|
> | `cron.schedule(...)` | InsForge schedules | `npx @insforge/cli schedules create --name --cron --url --method` |
> | `vault.create_secret(...)` | InsForge secrets | `npx @insforge/cli secrets add KEY VALUE` |
> | `ALTER PUBLICATION supabase_realtime ADD TABLE feed` | InsForge built-in realtime | no DDL — handled by SDK channels |
> | `current_setting('app.settings.X', true)` in a trigger | reference an InsForge secret in the function body, or move logic to an edge function | rewrite the trigger function |
>
> When the schedules' `url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'vercel_url') || '/v1/api/...'` pattern, the InsForge schedules `--headers` field supports `${{secrets.KEY_NAME}}` interpolation but the URL field is a literal — the worker URL must be hardcoded at schedule creation (or recreated when the deploy URL changes).

**Trigger to recognize this archetype during Step 0 probing:** if the source probe shows `pg_cron` and/or `supabase_vault` in the extensions list, ask the user: "Do you have any `cron.schedule()` jobs or `vault.secrets` entries you depend on?" If yes, plan separate per-job and per-secret migration steps in addition to the SQL schema baseline.

**Pitfalls captured from wdabt (added to migrate-database):**

1. **pg_dump v17 emits `\restrict` / `\unrestrict` psql meta-commands** and `SELECT pg_catalog.set_config('search_path', '', false);`. These break the InsForge migrations runner (which is the backend, not psql), and the `set_config` call also wipes the `SET search_path = public, pg_catalog` that the transform prepends. Transform now strips all three.
2. **`db migrations` baseline > direct psql.** Earlier guidance applied the schema with `psql -f insforge-ready.sql`. Cleaner: timestamp-rename the transformed file under `migrations/`, link the project, and run `npx @insforge/cli db migrations up --all` — the schema is then registered as a tracked baseline and future migrations chain from it. If the project isn't linked yet, dry-run with `psql --single-transaction -c "BEGIN;" -f file.sql -c "ROLLBACK;"` to verify cleanly first.

### Frontend completion (wdabt trial, 2026-04-26)

The Nuxt-specific frontend rewrite for this archetype is captured in `migrate-frontend-sdk/SKILL.md` under "Hard lessons from a real Nuxt trial (wdabt, 2026-04-26)". Key archetype-level facts the orchestrator should know:

- A Nuxt SSR app keeps `nitro: { preset: 'vercel' }` and deploys via `npx @insforge/cli deployments deploy app`. The frontend deployment path uses Vercel under the hood — operationally InsForge-managed, doesn't require switching to compute/Fly.io.
- The minimal-touch pattern is to have `useSupabaseAdmin()` (or whatever the existing server helper is named) return `client.database` directly so all `.from(`/`.rpc(`/`.select`/`.insert`/etc. call sites work unchanged. Single-file edit instead of bulk AST rewrite.
- `@vercel/analytics` and `@vercel/speed-insights` should be removed separately — independent of the Supabase→InsForge swap.
- Insert array-wrap is OPTIONAL on InsForge SDK 1.2.5+ — both `.insert({...})` and `.insert([{...}])` work. Skip the array-wrap AST pass for SDK ≥ 1.2.5.
- Order matters when removing `@nuxtjs/supabase`: edit `nuxt.config.ts` to drop the module from `modules` BEFORE `pnpm remove`, otherwise `nuxt prepare` postinstall fails.
