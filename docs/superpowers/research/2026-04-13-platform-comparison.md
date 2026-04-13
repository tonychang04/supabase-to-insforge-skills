# Supabase vs InsForge — Platform Architecture Comparison

**Date:** 2026-04-13
**Purpose:** Foundation doc for the migration skills. Captures how each platform actually works component-by-component, and how the boundary crossing maps.

---

## 1. Architecture at a glance

### Supabase — a constellation of open-source services

Supabase is an opinionated wrapper around a collection of services, each writing to a dedicated Postgres schema:

| Service | OSS project | Writes to | API surface |
|---|---|---|---|
| PostgREST | PostgREST | `public.*` (your tables) | `/rest/v1/*` REST over any schema |
| GoTrue | `auth` | `auth.users`, `auth.identities`, `auth.sessions`, `auth.mfa_factors`, `auth.sso_providers`, `auth.saml_providers`, 15+ auth tables | `/auth/v1/*` |
| Storage-API | `supabase-storage` | `storage.buckets`, `storage.objects` (metadata); bytes in S3/GCS backend | `/storage/v1/*` |
| Realtime | `supabase-realtime` | `realtime.*` (subscription bookkeeping); data streamed via WAL (logical replication) | WebSocket `/realtime/v1/*` |
| Edge Functions | `deno` runtime | Not in DB — deployed via CLI to a separate runtime | `/functions/v1/<fn>` |
| pg_graphql | Postgres extension | Reads `public.*` | `/graphql/v1` |
| Vault | `supabase_vault` extension | `vault.secrets` (encrypted) | SQL only |

All glued together by a reverse proxy (Kong in self-hosted, Supabase's own in cloud). One `supabase-js` client library calls all of these.

### InsForge — fewer services, more in-database

InsForge consolidates: auth, storage metadata, functions, realtime config, scheduled jobs, and AI are all first-class Postgres schemas in the *same* database. Fewer moving parts.

| InsForge component | Owns schema | API surface |
|---|---|---|
| Auth | `auth` (users, user_providers, email_otps, oauth_configs, config) | `/api/auth/*` |
| Storage | `storage` (buckets, objects, config); bytes in backend | `/api/storage/*` |
| Database API | No schema (reads `public.*`) | `/api/database/*` incl. `rawsql` |
| Functions | `functions` (definitions, deployments); Deno runtime | `/api/functions/<slug>` |
| Realtime | `realtime` (channels, config, messages) | WebSocket + webhook |
| Schedules | `schedules` + pg_cron extension | `/api/schedules/*` |
| AI | `ai` (configs, usage) — built-in LLM routing | `/api/ai/*` |
| System | `system` (audit_logs, deployments, secrets, migrations, mcp_usage) | admin only |

One `@insforge/sdk` client calls all of these.

---

## 2. Component-by-component comparison

### 2.1 Database & REST API

| Dimension | Supabase | InsForge |
|---|---|---|
| REST flavor | PostgREST (openapi-driven, schema-aware) | PostgREST-compatible dialect (same query syntax) |
| Select shape | `supabase.from('t').select('a,b,fk(*)')` | `client.database.from('t').select('a,b,fk(*)')` — identical |
| Insert | `supabase.from('t').insert([{...}])` | `client.database.from('t').insert([{...}])` |
| FK expansion | `*, fk:fk_col(*)` | same |
| Filters | `.eq()`, `.in()`, `.gte()`, etc. | same |
| Aggregations | limited; use RPC | `.from('t').select('count(*)')` where available |
| RPC / stored procs | `supabase.rpc('fn', {...})` | varies — check docs; raw SQL via `client.database.sql` |
| Raw SQL | Not exposed to client | **Yes**: `/api/database/advance/rawsql` (admin key required) |

**Migration action for code:** `supabase.*` → `client.database.*` prefix for DB calls. PostgREST query syntax is mostly drop-in. RPC calls need individual inspection.

### 2.2 Auth

**This is the highest-risk component.** The two services model auth very differently under the hood, even though user-facing flows look similar.

| Dimension | Supabase (GoTrue) | InsForge |
|---|---|---|
| User table columns | 35 (id, email, encrypted_password, phone, email_change_*, recovery_*, confirmation_*, MFA, SSO, SAML, 2FA, webauthn, etc.) | 10 (id, email, password, email_verified, profile, metadata, is_project_admin, is_anonymous, timestamps) |
| Password hash format | bcrypt `$2a$` or `$2b$` | bcrypt — **direct copy works** |
| Sessions | In `auth.sessions` (database-backed, revocable) | Stateless JWT (not migrated) |
| OAuth identities | Row in `auth.identities` per linked provider (provider, provider_id, identity_data jsonb, last_sign_in_at) | Row in `auth.user_providers` (provider, provider_account_id, access_token, refresh_token, provider_data) |
| MFA | `auth.mfa_factors`, `auth.mfa_challenges`, `auth.mfa_amr_claims` | Not first-class in core — rebuild via custom |
| SSO / SAML | `auth.sso_providers`, `auth.saml_providers`, `auth.saml_relay_states` | Custom via `auth.custom_oauth_configs` |
| Refresh tokens | `auth.refresh_tokens` table | JWT refresh (different mechanism) |
| Anonymous users | `auth.users.is_anonymous` | `auth.users.is_anonymous` — same |
| JWT claims | `sub=uid`, `aud=authenticated`, `role=authenticated` or `service_role`, `user_metadata`, `app_metadata`, `email` | Similar, but signing key differs |
| `auth.uid()` SQL helper | Yes (returns JWT sub claim as uuid) | **Yes** (verified) — RLS policies port unchanged |
| `auth.role()` SQL helper | Yes | **Yes** (verified) |
| `auth.email()` SQL helper | Yes | **Yes** (verified) |
| `auth.jwt()` SQL helper | Yes (returns full JWT as jsonb) | **No** — any policy using it must be rewritten |
| Service role | `service_role` (bypasses RLS) | `project_admin` (does NOT bypass RLS — needs explicit policies) |

**Critical difference: service_role vs project_admin behavior under RLS**

This is the single biggest semantic difference.

- Supabase `service_role` JWT → bypass RLS entirely (god-mode SELECT/INSERT/UPDATE/DELETE on anything).
- InsForge `project_admin` role → still subject to RLS. Admin API calls need an explicit policy per table: `TO project_admin USING (true) WITH CHECK (true)`.

**Action for migration:** for every table with RLS enabled in source, add an admin bypass policy for `project_admin` in the target. The reference repo's `transform-sql.ts` already does this.

**Migration action for auth:**

1. Export `auth.users` from source (9 columns that matter: id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, is_anonymous, created_at, updated_at).
2. Transform each row:
   - `encrypted_password` → `password` (direct copy of bcrypt hash)
   - `email_confirmed_at IS NOT NULL` → `email_verified boolean`
   - `raw_user_meta_data` → `metadata` (jsonb)
   - `raw_app_meta_data` → `profile` (jsonb) — or merge both into metadata under subkeys; pick one convention and document
3. INSERT into target `auth.users` preserving UUID (critical for FKs).
4. Export `auth.identities`, map to `auth.user_providers`:
   - `provider_id` → `provider_account_id`
   - `identity_data` → `provider_data`
   - Tokens are NOT in source — target columns stay NULL; user re-authorizes on first OAuth sign-in.

### 2.3 Storage

| Dimension | Supabase | InsForge |
|---|---|---|
| Bucket columns | id, name, public, file_size_limit, allowed_mime_types, owner, avif_autodetection | name, public, created_at, updated_at |
| Object columns | id, bucket_id, name, owner, path_tokens, version, metadata | bucket, key, size, mime_type, uploaded_at, uploaded_by |
| Byte backend | S3 / GCS | Proprietary backend |
| Download URL (public) | `https://PROJECT.supabase.co/storage/v1/object/public/{bucket}/{key}` | `{API_URL}/api/storage/buckets/{bucket}/objects/{key}` |
| Download URL (private, signed) | Signed URLs via `/storage/v1/object/sign/{bucket}/{key}` | Via SDK `.storage.from(b).createSignedUrl()` |
| Upload API | POST multipart to `/storage/v1/object/{bucket}/{path}` | PUT multipart to `/api/storage/buckets/{bucket}/objects/{key}` |
| RLS on objects | Yes — `storage.objects` has policies | Handled by InsForge storage layer (check docs for exact model) |
| Key encoding | Each path segment URI-encoded separately; slashes preserved | Same convention — verified in reference repo `encodeStorageKey()` |

**Migration action for storage:**

1. For each source bucket, call `mcp__insforge__create-bucket { name, public }` (idempotent if bucket exists).
2. List source objects: `SELECT bucket_id, name FROM storage.objects`.
3. For each object: download via Supabase Storage API, re-upload via `PUT /api/storage/buckets/{bucket}/objects/{segment-encoded-key}`.
4. Post-upload, run URL rewrite regex across every jsonb column in public schema (universal approach — matches pattern, not column name).

### 2.4 Realtime — **NOT a drop-in migration**

Two fundamentally different mental models.

| Supabase Realtime | InsForge Realtime |
|---|---|
| `supabase.channel('room-a').on('broadcast', {...}, cb).subscribe()` | `client.realtime.channel('room-a').on(cb)` — different shape |
| `supabase.channel().on('presence', ...)` | No presence equivalent |
| `supabase.channel().on('postgres_changes', {table: 't'}, cb)` — row-level change streaming via logical replication | Configure channel with a `pattern` + `webhook_urls` in `realtime.channels`; InsForge fires webhook on match |

**Migration action:** manual rewrite, case by case. Flag every `supabase.channel()` call-site for human review. Skills **do not auto-port realtime** — out of scope.

### 2.5 Edge Functions

| Dimension | Supabase | InsForge |
|---|---|---|
| Runtime | Deno | Deno |
| Deployment | `supabase functions deploy <fn>` from local `supabase/functions/<fn>/index.ts` | Row in `functions.definitions` with `code` column; deploy via `mcp__insforge__create-function` or `update-function` |
| Handler shape | `import { serve } from 'std/http/server.ts'; serve(async (req) => {...})` | `export default async function(req: Request): Promise<Response> {...}` |
| Env access | `Deno.env.get('X')` | `Deno.env.get('X')` — same runtime |
| Client library | `import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'` | `import { Insforge } from '@insforge/sdk'` |
| Secrets | Set via `supabase secrets set X=Y` | Stored in `system.secrets`; managed via MCP |
| Invocation | `supabase.functions.invoke('fn', { body })` | `client.functions.invoke('fn', { body })` |

**Migration action for edge functions:**
1. Discover: scan `supabase/functions/*/index.ts` in source repo.
2. Rewrite imports, handler shape, SDK init.
3. Migrate secrets to `system.secrets` (manual — encrypted values can't be ported).
4. Deploy via `mcp__insforge__create-function`.
5. Set `status = 'deployed'` (check default — starts as `'draft'`).

### 2.6 pg_graphql, Vault, pgsodium — **NOT supported on InsForge**

| Supabase | InsForge |
|---|---|
| `pg_graphql` extension | Not available — rewrite GraphQL queries to PostgREST/SDK |
| `supabase_vault` extension | `system.secrets` — manual re-entry (encrypted at rest, not copyable) |
| `pgsodium` | Not available — rewrite any encryption using it |

### 2.7 Schedules / cron

| Supabase | InsForge |
|---|---|
| `pg_cron` (self-hosted only) | **pg_cron built in** + `schedules.jobs` wrapper |
| Often done via external scheduler | First-class |

Migration: if source uses `pg_cron`, copy jobs. If source uses an external scheduler, consider moving to `schedules.jobs`.

### 2.8 AI — **InsForge has it, Supabase doesn't (natively)**

InsForge has `ai.configs` and `ai.usage` — provider-agnostic LLM routing built in. Not a migration concern, but worth noting as a post-migration opportunity.

---

## 3. Concrete JWT / role / RLS differences (deep dive)

### JWT signing

- Supabase JWTs are signed with an HS256 secret configured in the project.
- InsForge JWTs use the project's own signing key.

**Consequence:** tokens minted by Supabase are NOT valid on InsForge. Users must re-authenticate on first visit. Plan the cutover accordingly — existing active sessions will fail to renew.

### RLS policy rewriting rules (applied in order)

```
Source policy                    →   Target policy (modern InsForge)
─────────────────────────────────────────────────────────────────
auth.uid()                      →   auth.uid()   (keep — function exists)
auth.role()                     →   auth.role()  (keep)
auth.email()                    →   auth.email() (keep)
auth.jwt()                      →   REWRITE       (no equivalent; consult user)
TO service_role                 →   TO project_admin
TO authenticated                →   TO authenticated (role exists)
TO public                       →   TO public
REFERENCES auth.users(id)       →   REFERENCES auth.users(id)  (keep — schema exists)
```

**Additionally:** for every table with RLS enabled, add an admin bypass:

```sql
DROP POLICY IF EXISTS "Admin full access to <table>" ON public.<table>;
CREATE POLICY "Admin full access to <table>" ON public.<table>
  TO "project_admin" USING (true) WITH CHECK (true);
```

This is the one thing API keys (project_admin role) can't do without an explicit policy, unlike Supabase's service_role which bypasses RLS automatically.

---

## 4. Reference repo (InsForge/supabase-to-insforge) — what's still useful, what's stale

The toolkit at https://github.com/InsForge/supabase-to-insforge was written against an **older InsForge schema** where auth lived in `_accounts` and storage in `_storage`. Against today's InsForge (schemas `auth.*`, `storage.*`), several transforms are either wrong or no-ops.

| Reference repo step | Status on modern InsForge |
|---|---|
| `export:auth` (read Supabase auth.users) | ✅ Still correct |
| `import:auth` INSERTS into `_accounts` and `users` tables | ❌ **Wrong** — should INSERT into `auth.users` and `auth.user_providers` |
| `export:db` with `pg_dump --schema=public --no-owner --no-privileges` | ✅ Correct |
| `transform:db` — `auth.users → _accounts` rewrite | ⚠️ No-op for schemas with no auth.users FK; wrong if any FK references auth.users |
| `transform:db` — `auth.uid() → uid()` rewrite | ❌ **Wrong** on modern InsForge (auth.uid() exists and works) |
| `transform:db` — strip GRANT, ALTER OWNER, RESET ALL | ✅ Still correct (API import endpoint restriction) |
| `transform:db` — `service_role → project_admin` | ✅ Still correct |
| `transform:db` — Admin policy injection for `project_admin` | ✅ Still correct — critical step |
| `transform:db` — Add `DROP IF EXISTS` for idempotency | ✅ Correct |
| `transform:db` — `public.users` → `supabase_users` rename | ⚠️ Old InsForge had a built-in `public.users` table; modern doesn't. Verify before applying. |
| COPY→INSERT conversion bug | ⚠️ Known (MIGRATION-STATUS.md); worked around by using direct psql instead of API import |
| `create:buckets` | ✅ Still correct (uses API endpoints that work) |
| `export:storage` | ✅ Still correct |
| `import:storage` PUT with segment-encoded keys | ✅ Still correct |
| `update:storage-urls` universal regex | ✅ Still correct |

**Takeaway for skills:** the skills should **probe modern InsForge first, then selectively apply** reference-repo transforms, not run them wholesale.

---

## 5. What this means for the skills

The 5 child skills + orchestrator need to encode these decisions:

1. **Orchestrator** — detects target model (modern vs legacy) via a single diagnostic query on `auth.users` existence, then dispatches with the right strategy.
2. **migrate-database** — applies ONLY the transforms that are correct for the detected target. Always adds admin bypass policies.
3. **migrate-auth** — inserts into `auth.users` (not `_accounts`) on modern target; uses UUID preservation and bcrypt direct copy.
4. **migrate-storage** — bucket + object migration + URL rewrite; documents private-bucket service-key requirement.
5. **migrate-edge-functions** — manual rewrite with a concrete side-by-side template; deploys via MCP.
6. **migrate-frontend-sdk** — `supabase-js` → `@insforge/sdk` cheat sheet + grep-based inventory.

Realtime + Vault + pg_graphql + MFA + SSO/SAML: **documented as manual follow-ups** in the orchestrator's post-migration checklist, never auto-ported.
