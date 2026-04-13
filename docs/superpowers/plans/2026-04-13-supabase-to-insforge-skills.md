# Supabase → InsForge Migration Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 5 Claude skills that guide any future Claude through a Supabase → InsForge migration by (a) probing both live systems, (b) choosing the right strategy based on what's found, (c) orchestrating the production-tested script toolkit at https://github.com/InsForge/supabase-to-insforge, and (d) covering the gaps (edge functions, frontend SDK rewrite, schema drift).

**Architecture:** Skills live in `/Users/gary/projects/test4/skills/`. Each skill is a single `SKILL.md` with YAML frontmatter. Skills are diagnostic-first: before recommending any transformation they probe both databases and select strategy. The existing `InsForge/supabase-to-insforge` repo is treated as a **reference toolkit** the skills call into — the skills wrap, diagnose, and extend it, they do not replace it.

**Tech Stack:** Markdown + YAML frontmatter for skills. `psql` + `pg_dump` for probing. Shell + `gh` for cloning the reference repo. No new TypeScript code — we fix the reference repo only if the trial uncovers show-stoppers.

**Key reality checks already verified against live creds:**

| Fact | Source evidence |
|---|---|
| Source Supabase has 35 RLS-enabled public tables, 9 users, 3 buckets, 83 objects | live `psql` probe during brainstorming |
| InsForge target has `auth.users` (not `_accounts`), `storage.objects` (not `_storage`), `auth.uid()` works, `auth.user_providers` (not `_account_providers`) | live `psql` probe during brainstorming |
| Reference repo's `transform-sql.ts` maps `auth.users → _accounts` and `auth.uid() → uid()` — **both wrong against today's InsForge** | reading `/tmp/supabase-to-insforge/database/transform-sql.ts` |
| Reference repo has a known bug: COPY→INSERT regex runs after `\.` stripping | `MIGRATION-STATUS.md` in the repo |
| Reference repo does NOT migrate: realtime, edge functions, OAuth tokens | `README.md` §"What This Tool Does NOT Migrate" |

---

## File structure

```
/Users/gary/projects/test4/
├── docs/superpowers/
│   ├── specs/2026-04-13-supabase-to-insforge-skills-design.md   (exists)
│   └── plans/2026-04-13-supabase-to-insforge-skills.md          (this file)
├── skills/
│   ├── supabase-to-insforge/SKILL.md          # orchestrator (entry point)
│   ├── migrate-database/SKILL.md              # schema + data + RLS
│   ├── migrate-auth/SKILL.md                  # users + OAuth identities
│   ├── migrate-storage/SKILL.md               # buckets + objects
│   ├── migrate-edge-functions/SKILL.md        # Deno fn → InsForge functions
│   └── migrate-frontend-sdk/SKILL.md          # @supabase/supabase-js → @insforge/sdk
└── .trial-migration/                          # scratch dir — probe outputs, logs, artifacts
    ├── probe-source.txt
    ├── probe-target.txt
    ├── drift-report.md
    └── trial-log.md                           # running journal for "Common pitfalls" sections
```

Each `SKILL.md` carries YAML frontmatter (`name`, `description`) + 7 sections: **When to invoke · Inputs required · Diagnostic probe · Decision table · Procedure · Verification · Common pitfalls · Scope boundary**.

---

## Task decomposition

15 tasks. Tasks 1–2 scaffold. Tasks 3–5 are the trial migration (the grounding). Tasks 6–11 write each skill, one per subsystem, each using trial-log evidence. Task 12 is the orchestrator. Tasks 13–15 are verification, self-review, and handoff.

---

### Task 1: Scaffold skill directory + empty SKILL.md files

**Files:**
- Create: `skills/supabase-to-insforge/SKILL.md`
- Create: `skills/migrate-database/SKILL.md`
- Create: `skills/migrate-auth/SKILL.md`
- Create: `skills/migrate-storage/SKILL.md`
- Create: `skills/migrate-edge-functions/SKILL.md`
- Create: `skills/migrate-frontend-sdk/SKILL.md`

- [ ] **Step 1: Create directory tree**

```bash
cd /Users/gary/projects/test4
mkdir -p skills/supabase-to-insforge skills/migrate-database skills/migrate-auth skills/migrate-storage skills/migrate-edge-functions skills/migrate-frontend-sdk .trial-migration
```

- [ ] **Step 2: Write frontmatter stub for each SKILL.md**

Each file gets this exact scaffold (vary only `name` and `description`):

```markdown
---
name: <skill-name>
description: <one-sentence trigger>
---

# <Human Title>

_Stub — filled in Task N._
```

Concrete values:

| File | name | description |
|---|---|---|
| `skills/supabase-to-insforge/SKILL.md` | `supabase-to-insforge` | Use when a user wants to migrate an application from Supabase to InsForge. Orchestrates database, auth, storage, edge function, and frontend SDK migration. Invokes child skills in dependency order and produces an inventory report first. |
| `skills/migrate-database/SKILL.md` | `migrate-database` | Use when migrating PostgreSQL schema and data (including RLS policies, triggers, and functions) from a Supabase project to InsForge. Handles schema drift between legacy InsForge (`_accounts`) and modern InsForge (`auth.users`). |
| `skills/migrate-auth/SKILL.md` | `migrate-auth` | Use when migrating Supabase `auth.users` and `auth.identities` to InsForge. Preserves UUIDs and bcrypt password hashes so users keep their existing passwords. |
| `skills/migrate-storage/SKILL.md` | `migrate-storage` | Use when migrating Supabase Storage buckets and objects to InsForge, preserving exact keys and updating URL references embedded in JSONB columns. |
| `skills/migrate-edge-functions/SKILL.md` | `migrate-edge-functions` | Use when migrating Supabase Edge Functions (Deno) to InsForge Functions. Rewrites imports, handler shape, env access, and deploys via the InsForge MCP tools. |
| `skills/migrate-frontend-sdk/SKILL.md` | `migrate-frontend-sdk` | Use when rewriting a frontend codebase from `@supabase/supabase-js` to `@insforge/sdk`. Covers auth, database, storage, and function invocation call-site rewrites. |

- [ ] **Step 3: Commit**

```bash
git add skills/
git commit -m "scaffold: 5 skill stubs for Supabase → InsForge migration

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Clone the reference toolkit into the scratch dir

**Files:**
- Create: `.trial-migration/supabase-to-insforge/` (git clone)

- [ ] **Step 1: Clone**

```bash
cd /Users/gary/projects/test4/.trial-migration
rm -rf supabase-to-insforge
gh repo clone InsForge/supabase-to-insforge
```

- [ ] **Step 2: Verify files land**

```bash
ls .trial-migration/supabase-to-insforge/
# Expected: auth/ database/ storage/ README.md MIGRATION-STATUS.md package.json ...
```

- [ ] **Step 3: Install deps (so we can actually run scripts during trial)**

```bash
cd .trial-migration/supabase-to-insforge && npm install 2>&1 | tail -5
```
Expected: "added N packages" with no fatal errors.

- [ ] **Step 4: Write `.env` for the trial**

```bash
cat > .trial-migration/supabase-to-insforge/.env <<'EOF'
SUPABASE_DB_URL=postgresql://postgres.jnaynuqhbfchrblquaoc:WEwZzZSGWMci8t52@aws-1-us-east-2.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://jnaynuqhbfchrblquaoc.supabase.co
INSFORGE_API_URL=TBD_AFTER_PROBE
INSFORGE_API_KEY=TBD_AFTER_PROBE
EOF
```

Note: `INSFORGE_API_URL` and `INSFORGE_API_KEY` are filled in Task 3 once we get them via `mcp__insforge__get-backend-metadata` and `mcp__insforge__get-anon-key`.

`.trial-migration/` is untracked — no commit.

---

### Task 3: Diagnostic probe — source Supabase + target InsForge

**Files:**
- Create: `.trial-migration/probe-source.txt`
- Create: `.trial-migration/probe-target.txt`
- Create: `.trial-migration/drift-report.md`

- [ ] **Step 1: Probe source — capture shape once, reference throughout**

```bash
export PGPASSWORD='WEwZzZSGWMci8t52'
psql "postgresql://postgres.jnaynuqhbfchrblquaoc@aws-1-us-east-2.pooler.supabase.com:6543/postgres" <<'SQL' > /Users/gary/projects/test4/.trial-migration/probe-source.txt 2>&1
\echo === schemas ===
SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('public','auth','storage','realtime','vault','graphql_public') ORDER BY 1;
\echo === public tables ===
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1;
\echo === public table row counts ===
SELECT schemaname, relname AS tablename, n_live_tup AS rows FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY n_live_tup DESC;
\echo === RLS policy count per table ===
SELECT tablename, count(*) AS n_policies FROM pg_policies WHERE schemaname='public' GROUP BY 1 ORDER BY 1;
\echo === auth users ===
SELECT count(*) FROM auth.users;
\echo === auth identities ===
SELECT provider, count(*) FROM auth.identities GROUP BY provider;
\echo === storage buckets ===
SELECT id, name, public FROM storage.buckets;
\echo === storage object counts ===
SELECT bucket_id, count(*), pg_size_pretty(sum((metadata->>'size')::bigint)) AS total_size FROM storage.objects GROUP BY bucket_id;
\echo === extensions ===
SELECT extname, extversion FROM pg_extension ORDER BY 1;
\echo === triggers on public ===
SELECT event_object_table, trigger_name, event_manipulation FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY 1;
\echo === functions defined in public ===
SELECT proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.prokind='f' ORDER BY 1;
SQL
```

- [ ] **Step 2: Probe target — determine schema model (legacy `_accounts` vs modern `auth.users`)**

```bash
export PGPASSWORD='f648e7c759c7430e8987c5ce597989f6'
psql "postgresql://postgres@kx9jfb7d.us-east.database.insforge.app:5432/insforge?sslmode=require" <<'SQL' > /Users/gary/projects/test4/.trial-migration/probe-target.txt 2>&1
\echo === schemas ===
SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema' ORDER BY 1;
\echo === auth.users columns ===
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='auth' AND table_name='users' ORDER BY ordinal_position;
\echo === auth helper functions ===
SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE p.proname IN ('uid','jwt','role') ORDER BY 1,2;
\echo === does public._accounts exist? (legacy indicator) ===
SELECT count(*) AS has_legacy_accounts FROM information_schema.tables WHERE table_schema='public' AND table_name='_accounts';
\echo === does public._storage exist? (legacy indicator) ===
SELECT count(*) AS has_legacy_storage FROM information_schema.tables WHERE table_schema='public' AND table_name='_storage';
\echo === existing public tables ===
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1;
\echo === existing RLS policies ===
SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname NOT IN ('pg_catalog') ORDER BY 1,2,3;
\echo === storage.buckets columns ===
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='storage' AND table_name='buckets' ORDER BY ordinal_position;
\echo === storage.objects columns ===
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects' ORDER BY ordinal_position;
SQL
```

- [ ] **Step 3: Fetch InsForge API URL + key via MCP**

```
# Use MCP tool: mcp__insforge__get-backend-metadata  (returns API URL + base host)
# Use MCP tool: mcp__insforge__get-anon-key           (returns anon key)
```

Capture both values and update `.trial-migration/supabase-to-insforge/.env`. If the MCP tools target a *different* InsForge instance than `kx9jfb7d.us-east.database.insforge.app`, stop and surface to the user: we need an API key paired with the target DB.

- [ ] **Step 4: Write drift-report.md**

Create `.trial-migration/drift-report.md` with these sections, filled from the probe outputs:

```markdown
# Schema drift — reference toolkit assumes vs target reality

## Target schema model
- [ ] Modern InsForge (`auth.users`, `auth.user_providers`, `storage.objects`)
- [ ] Legacy InsForge (`_accounts`, `_account_providers`, `_storage`)
(Check exactly one based on probe-target.txt)

## Transformations in reference toolkit — applicability to THIS target
| transform-sql.ts rule | Applies to modern? | Applies to legacy? | Action for this target |
|---|---|---|---|
| `auth.users` → `_accounts` | NO — breaks FK | YES | _fill_ |
| `auth.uid()` → `uid()` | Only if `uid()` also exists in search_path | YES | _fill — test both on target_ |
| `service_role` → `project_admin` | _verify_ | YES | _fill_ |
| Admin policies `TO "project_admin"` | _verify role exists_ | YES | _fill_ |

## Open questions to answer during trial
- Does `uid()` (unqualified) resolve on modern target? (search_path test)
- Is `project_admin` a role on modern target?
- Does the `/api/database/advance/rawsql/unrestricted` endpoint exist on modern target?
- Does `/api/auth/users` accept a pre-set `id` field?
```

- [ ] **Step 5: Commit the drift-report stub (other files ignored via gitignore)**

```bash
cd /Users/gary/projects/test4
echo "/.trial-migration/" > .gitignore
git add .gitignore
git commit -m "gitignore trial migration scratch dir

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Trial migration — database

Goal: actually run the reference toolkit's DB pipeline against our sample creds and record every friction point into `.trial-migration/trial-log.md`.

**Files:**
- Read: `.trial-migration/supabase-to-insforge/database/export-database.ts`
- Read: `.trial-migration/supabase-to-insforge/database/transform-sql.ts`
- Create: `.trial-migration/trial-log.md` (appended to throughout tasks 4-8)

- [ ] **Step 1: Initialize trial log**

```bash
cat > /Users/gary/projects/test4/.trial-migration/trial-log.md <<'EOF'
# Trial migration log
Running journal. Every pitfall here becomes a "Common pitfalls" entry in the relevant SKILL.md.

## Database (Task 4)
_pending_

## Auth (Task 5)
_pending_

## Storage (Task 6)
_pending_
EOF
```

- [ ] **Step 2: Run schema-only export to isolate transform behavior**

```bash
cd /Users/gary/projects/test4/.trial-migration/supabase-to-insforge
pg_dump "$SUPABASE_DB_URL" --schema=public --schema-only --no-owner --no-privileges > database/supabase-dump.sql 2>&1
echo "--- lines: $(wc -l < database/supabase-dump.sql)"
```

Record in trial-log.md: line count, whether any warnings appeared.

- [ ] **Step 3: Run transform and inspect for the documented COPY bug + the legacy-model remapping**

```bash
cd /Users/gary/projects/test4/.trial-migration/supabase-to-insforge
npx tsx database/transform-sql.ts 2>&1 | tee ../transform-run.log
grep -cE '^COPY ' database/insforge-ready.sql
grep -cE 'REFERENCES "_accounts"' database/insforge-ready.sql
grep -cE '\buid\(\)' database/insforge-ready.sql
```

Expected findings (based on drift-report decision):
- If target is modern: `REFERENCES "_accounts"` count will be > 0 → **this SQL will fail against our target**; log as major pitfall, need a "modern target patch" step.
- `uid()` count > 0 → these need to become `auth.uid()` on modern target OR we need to add a public `uid()` wrapper.

Log findings in trial-log.md under "Database — transform drift findings".

- [ ] **Step 4: If target is modern, write a post-transform fix step and apply it**

```bash
cd /Users/gary/projects/test4/.trial-migration/supabase-to-insforge
# Reverse the two wrong transforms. Modern target has auth.users and auth.uid().
sed -i.bak 's/REFERENCES "_accounts"/REFERENCES "auth"."users"/g; s/\buid()/auth.uid()/g' database/insforge-ready.sql
diff database/insforge-ready.sql.bak database/insforge-ready.sql | head -30
```

Log the exact diff in trial-log.md — this becomes the "modern target patch" recipe in the migrate-database skill.

- [ ] **Step 5: Apply the transformed SQL directly via the target's direct DB connection (bypass the API import endpoint to avoid the unknown restrictions)**

```bash
export PGPASSWORD='f648e7c759c7430e8987c5ce597989f6'
psql "postgresql://postgres@kx9jfb7d.us-east.database.insforge.app:5432/insforge?sslmode=require" \
  -v ON_ERROR_STOP=0 \
  -f /Users/gary/projects/test4/.trial-migration/supabase-to-insforge/database/insforge-ready.sql 2>&1 | tee /Users/gary/projects/test4/.trial-migration/db-apply.log | tail -50
```

Record: total errors, first 5 error messages verbatim. Every distinct error class becomes a pitfall entry.

- [ ] **Step 6: Verify table + row counts on target**

```bash
psql "postgresql://postgres@kx9jfb7d.us-east.database.insforge.app:5432/insforge?sslmode=require" -c "
  SELECT count(*) AS table_count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';
"
psql "postgresql://postgres@kx9jfb7d.us-east.database.insforge.app:5432/insforge?sslmode=require" -c "
  SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY n_live_tup DESC LIMIT 10;
"
```

Expected: 35 tables (or close) after schema load; row counts zero until Task 4b (data load, below).

- [ ] **Step 7: Data load — export + COPY-to-direct-connection (skip the API entirely)**

```bash
cd /Users/gary/projects/test4/.trial-migration/supabase-to-insforge
pg_dump "$SUPABASE_DB_URL" --schema=public --data-only --no-owner --no-privileges --disable-triggers > database/supabase-data.sql
# Apply via direct connection — COPY FROM stdin works here, unlike the API import endpoint
export PGPASSWORD='f648e7c759c7430e8987c5ce597989f6'
psql "postgresql://postgres@kx9jfb7d.us-east.database.insforge.app:5432/insforge?sslmode=require" \
  -v ON_ERROR_STOP=0 \
  -f database/supabase-data.sql 2>&1 | tail -30
```

Record: rows loaded per table, any FK violations (likely due to `auth.users` being empty — we load users in Task 5).

- [ ] **Step 8: Commit trial-log updates (the scratch dir itself stays gitignored; instead, copy findings into a committed file)**

```bash
cd /Users/gary/projects/test4
mkdir -p docs/superpowers/research
cp .trial-migration/trial-log.md docs/superpowers/research/2026-04-13-trial-log.md
cp .trial-migration/drift-report.md docs/superpowers/research/2026-04-13-drift-report.md
git add docs/superpowers/research/
git commit -m "trial: database migration findings

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Trial migration — auth

- [ ] **Step 1: Determine API shape — legacy `/api/auth/users` vs modern**

Use `mcp__insforge__fetch-docs` with query `"auth users create admin"` to find the canonical endpoint for creating users with a pre-set ID.

Log the endpoint shape in trial-log.md.

- [ ] **Step 2: Export the 9 auth.users from source**

```bash
export PGPASSWORD='WEwZzZSGWMci8t52'
psql "postgresql://postgres.jnaynuqhbfchrblquaoc@aws-1-us-east-2.pooler.supabase.com:6543/postgres" <<'SQL' > /Users/gary/projects/test4/.trial-migration/auth-export.json
\t on
\pset format unaligned
SELECT jsonb_agg(jsonb_build_object(
  'id', id,
  'email', email,
  'password', encrypted_password,
  'email_verified', (email_confirmed_at IS NOT NULL),
  'metadata', raw_user_meta_data,
  'profile', raw_app_meta_data,
  'created_at', created_at,
  'updated_at', updated_at
)) FROM auth.users;
SQL
```

- [ ] **Step 3: Insert into target `auth.users` via direct SQL**

Attempt FIRST via direct SQL (what we have reliable access to). The column set on modern target is `(id, email, password, email_verified, created_at, updated_at, profile, metadata, is_project_admin, is_anonymous)`.

```bash
cat > /Users/gary/projects/test4/.trial-migration/auth-import.sql <<'EOF'
-- Insert the 9 exported users.
-- Password column is bcrypt hash copied from Supabase encrypted_password.
-- Using ON CONFLICT (id) DO UPDATE for idempotency.
INSERT INTO auth.users (id, email, password, email_verified, created_at, updated_at, profile, metadata, is_project_admin, is_anonymous)
VALUES
  -- filled from auth-export.json — one row per user
  ;
EOF
```

Generate the `VALUES` rows from `auth-export.json` (simple jq one-liner during execution). Apply:

```bash
export PGPASSWORD='f648e7c759c7430e8987c5ce597989f6'
psql "postgresql://postgres@kx9jfb7d.us-east.database.insforge.app:5432/insforge?sslmode=require" -f /Users/gary/projects/test4/.trial-migration/auth-import.sql
```

Log: row insert count, any errors (e.g., missing `email_verified` not null, unexpected defaults).

- [ ] **Step 4: Test password login with a sample user**

Pick one user email from the export. Use the InsForge API to call `POST /api/auth/sessions` (or equivalent — discovered in Step 1) with original password (UNKNOWN — would require user to provide one). Since we don't know any original passwords, instead *verify the stored hash format round-trips*:

```bash
psql "postgresql://postgres@kx9jfb7d.us-east.database.insforge.app:5432/insforge?sslmode=require" -c "
SELECT email, LEFT(password, 7) AS bcrypt_prefix FROM auth.users LIMIT 5;
"
# Expect: $2a$XX or $2b$XX
```

Log result. This is the best we can do without user credentials — the skill will document the `bcrypt-compat` test the user can run with their own credentials.

- [ ] **Step 5: Migrate `auth.identities` → `auth.user_providers`**

```bash
export PGPASSWORD='WEwZzZSGWMci8t52'
psql "postgresql://postgres.jnaynuqhbfchrblquaoc@aws-1-us-east-2.pooler.supabase.com:6543/postgres" -c "
SELECT user_id, provider, provider_id AS provider_account_id, identity_data FROM auth.identities LIMIT 5;
" > /Users/gary/projects/test4/.trial-migration/identities-sample.txt

# Build INSERT for auth.user_providers (columns: id, user_id, provider, provider_account_id, access_token, refresh_token, provider_data, created_at, updated_at)
```

Log row count and any shape mismatches.

- [ ] **Step 6: Append Task 5 findings to trial-log.md, copy to docs/, commit**

---

### Task 6: Trial migration — storage

- [ ] **Step 1: List source buckets, list target buckets**

```bash
# Source
export PGPASSWORD='WEwZzZSGWMci8t52'
psql "postgresql://postgres.jnaynuqhbfchrblquaoc@aws-1-us-east-2.pooler.supabase.com:6543/postgres" -c "SELECT id, name, public FROM storage.buckets;"
# Target — via MCP
# mcp__insforge__list-buckets
```

- [ ] **Step 2: Create matching buckets on target using the MCP tool**

```
# For each source bucket:
#   mcp__insforge__create-bucket { "name": <bucket-name>, "public": <bool> }
# Verify with list-buckets
```

Log any errors (e.g., bucket already exists → treat as idempotent).

- [ ] **Step 3: Download one sample object from source and re-upload to target**

Use `curl` against the Supabase Storage API with the service role key. BUT: we only have the DB service role, not a Storage service key. Fallback: **use the `SUPABASE_URL`-based public URL for objects in public buckets (desktop-releases)**, and flag that private-bucket migration needs the Supabase anon+service key which the user hasn't provided.

```bash
# Sample: download one file from desktop-releases (public bucket, 19 files)
curl -o /tmp/sample-object.bin \
  "https://jnaynuqhbfchrblquaoc.supabase.co/storage/v1/object/public/desktop-releases/<key-from-query>"

# Upload to target via PUT:
INSFORGE_API_URL=<from-probe>
INSFORGE_API_KEY=<from-probe>
curl -X PUT \
  -H "Authorization: Bearer $INSFORGE_API_KEY" \
  -F "file=@/tmp/sample-object.bin" \
  "$INSFORGE_API_URL/api/storage/buckets/desktop-releases/objects/<encoded-key>"
```

Log: whether key is preserved exactly, whether encoding rules differ, HTTP response.

- [ ] **Step 4: Verify on target**

```bash
psql "postgresql://postgres@kx9jfb7d.us-east.database.insforge.app:5432/insforge?sslmode=require" -c "
SELECT bucket, key, size, mime_type FROM storage.objects ORDER BY uploaded_at DESC LIMIT 5;
"
```

- [ ] **Step 5: Document the private-bucket gap**

Since we don't have a Supabase service role key, private bucket migration (datarooms: 63 objects) cannot be trialed. Log: the skill must instruct the user to supply `SUPABASE_SERVICE_ROLE_KEY` in `.env`; reference repo already handles this path via `export-storage.ts` using the Supabase JS client.

- [ ] **Step 6: Append, copy, commit (same pattern as Tasks 4–5)**

---

### Task 7: Write `migrate-database/SKILL.md`

**File:** `skills/migrate-database/SKILL.md`

- [ ] **Step 1: Draft SKILL.md using the trial-log.md evidence**

Structure (every section mandatory):

```markdown
---
name: migrate-database
description: Use when migrating PostgreSQL schema and data (including RLS policies, triggers, and functions) from a Supabase project to InsForge. Handles schema drift between legacy InsForge (`_accounts`) and modern InsForge (`auth.users`).
---

# Migrate Database (Supabase → InsForge)

## When to invoke
- The user asks to migrate their database from Supabase to InsForge.
- The `supabase-to-insforge` orchestrator dispatches to this skill.
- Do NOT invoke for: InsForge-only projects, realtime migration, edge function migration.

## Inputs required
- `SUPABASE_DB_URL` — source read-access connection string.
- `INSFORGE_DB_URL` — target direct-Postgres write-access connection string (preferred) or `INSFORGE_API_URL` + `INSFORGE_API_KEY` for API-based import.
- Answer: is the target a *modern* InsForge (`auth.users` exists) or *legacy* (`_accounts` exists)? — determined by the diagnostic probe.

## Diagnostic probe (ALWAYS run first)
<exact SQL from Task 3 Step 2, with expected output shape>

## Decision table
| Probe finding | Strategy |
|---|---|
| target has `auth.users`, no `_accounts` | Modern — use **direct SQL load** via `psql`. Skip the reference repo's `auth.users → _accounts` and `auth.uid() → uid()` transforms. |
| target has `_accounts`, no `auth.users` | Legacy — use the reference repo unchanged (`transform-sql.ts` is correct). |
| both exist | STOP — unexpected state; surface to user. |
| neither exists | STOP — probable connection or permissions issue. |

## Procedure (modern target)
<numbered steps with exact pg_dump + sed + psql commands from Task 4 Steps 2,3,4,5,7 — copy verbatim>

## Procedure (legacy target)
<reference `npm run export:db && npm run transform:db && npm run import:db` with notes on the known COPY bug — instruct reader to check `MIGRATION-STATUS.md` in the reference repo for the fix>

## Verification
<queries from Task 4 Step 6 and Step 7 tail — including row-count comparison to source>

## Common pitfalls
<populated from .trial-migration/trial-log.md "Database" section — every error class we actually hit>
- pg_dump version < 17 produces incompatible output
- COPY FROM stdin blocked by `/api/database/advance/import` — use direct psql or the `unrestricted` rawsql endpoint
- RLS `auth.uid()` transform — leave as-is on modern target; transform to `uid()` only on legacy
- `public.users` table collision with InsForge's built-in `users` table — reference repo renames to `supabase_users`
- ALTER TABLE OWNER, GRANT, RESET ALL must be stripped
- auth.users FK references must be loaded AFTER users are inserted (Task 5) — otherwise FK violations on data load

## Scope boundary
Does NOT cover: auth users (invoke `migrate-auth`), storage (invoke `migrate-storage`), realtime publications (out of scope), supabase_vault secrets (manual).
```

- [ ] **Step 2: Self-check the skill**

Re-read the skill file. Confirm:
- Every SQL snippet copy-pastes and runs standalone.
- Decision table has no undefined terms.
- Every pitfall has a matching entry in `.trial-migration/trial-log.md`.

- [ ] **Step 3: Commit**

```bash
git add skills/migrate-database/SKILL.md
git commit -m "migrate-database skill: grounded in live trial findings

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Write `migrate-auth/SKILL.md`

Same structure as Task 7. Key content (derived from Task 5 findings):

- [ ] **Step 1: Draft SKILL.md**

Sections to emphasize:

- **Password preservation**: bcrypt `$2a$`/`$2b$` hashes port directly between Supabase `encrypted_password` and InsForge `auth.users.password`. Reference: README § "Password Migration Strategy".
- **UUID preservation**: users MUST be inserted with their Supabase IDs — otherwise every FK in the migrated public schema breaks. Direct SQL INSERT is the safe path on modern target.
- **Metadata mapping**: Supabase `raw_user_meta_data` → InsForge `metadata` (jsonb). `raw_app_meta_data` → merge into `profile` or store as `metadata.app` subkey — document the trial's choice.
- **OAuth identities**: Supabase `auth.identities` rows → InsForge `auth.user_providers` rows. `identities.provider_id` → `user_providers.provider_account_id`. `identity_data` JSON → `provider_data`. Access/refresh tokens are NOT preserved — users must re-authorize.
- **Diagnostic**: before inserting, SELECT the column set of target `auth.users` and compare to expected modern shape. If shape differs (e.g., new required column), stop and surface.

- [ ] **Step 2: Include verification SQL for** row count, bcrypt prefix check, provider count.

- [ ] **Step 3: Pitfalls** — whatever the trial uncovered (unique constraint on email, is_anonymous NOT NULL default, etc.).

- [ ] **Step 4: Commit.**

---

### Task 9: Write `migrate-storage/SKILL.md`

- [ ] **Step 1: Draft SKILL.md** structured around:
  - Diagnostic: list source buckets; list target buckets; compare names.
  - Create missing target buckets via `mcp__insforge__create-bucket { name, public }`.
  - For each object: download from Supabase, upload to InsForge via PUT with segment-encoded key.
  - **Private buckets require** `SUPABASE_SERVICE_ROLE_KEY` in env — use the Supabase JS client's `.storage.from(bucket).download(key)`. Public buckets can use raw `https://<project>.supabase.co/storage/v1/object/public/<bucket>/<key>`.
  - **URL rewrite pass**: after upload, run the universal JSONB regex replace across public schema (from repo's `update-storage-urls.ts`) to fix any stored URLs. Old pattern: `https://PROJECT.supabase.co/storage/v1/object/public/{bucket}/{key}`. New pattern: `{INSFORGE_API_URL}/api/storage/buckets/{bucket}/objects/{key}`.
  - **Key encoding rule** (from reference repo `storage/import-storage.ts:25-27`):

```typescript
function encodeStorageKey(key: string): string {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/');
}
```

  - Verification: target object count matches source; sample public URL loads in browser.

- [ ] **Step 2: Pitfalls** — `File too large` errors, duplicate `(1).jpg` suffixes on re-run, private/public bucket distinction.

- [ ] **Step 3: Commit.**

---

### Task 10: Write `migrate-edge-functions/SKILL.md`

**Note:** The trial source doesn't have discoverable edge functions via DB (they live in a separate Supabase storage area). This skill is based on the reference repo's limitations + what's documented in InsForge docs.

- [ ] **Step 1: Draft SKILL.md** covering:
  - **Discovery**: look in the user's frontend repo under `supabase/functions/<fn-name>/index.ts`. If not present, ask the user where their functions live.
  - **Rewrite rules** (with side-by-side examples):

```typescript
// Supabase Edge Function
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
serve(async (req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  // ...
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' }})
})
```

```typescript
// InsForge Function (Deno runtime, deployed via MCP create-function)
import { Insforge } from '@insforge/sdk'
export default async function handler(req: Request): Promise<Response> {
  const client = new Insforge({ apiUrl: Deno.env.get('INSFORGE_API_URL')!, apiKey: Deno.env.get('INSFORGE_API_KEY')! })
  // ...
  return Response.json(result)
}
```

  - **Deploy**: use `mcp__insforge__create-function { slug, name, code, description }` — the function body gets stored in `functions.definitions.code`. Verify with `mcp__insforge__get-function`.
  - **Secret migration**: any `Deno.env.get('X')` secrets must be re-created via InsForge's secret mechanism (query `mcp__insforge__fetch-docs` for the current secret-set API).

- [ ] **Step 2: Pitfalls** — differing handler signatures, no `serve()` equivalent, different `Response` helper import.

- [ ] **Step 3: Commit.**

---

### Task 11: Write `migrate-frontend-sdk/SKILL.md`

- [ ] **Step 1: Draft SKILL.md** with a **rewrite cheat sheet**:

| Supabase-js | InsForge SDK | Notes |
|---|---|---|
| `import { createClient } from '@supabase/supabase-js'` | `import { Insforge } from '@insforge/sdk'` | |
| `const supabase = createClient(url, anonKey)` | `const client = new Insforge({ apiUrl, anonKey })` | env var names change |
| `await supabase.auth.signUp({ email, password })` | `await client.auth.signUp({ email, password })` | largely identical shape |
| `await supabase.auth.signInWithPassword({ email, password })` | `await client.auth.signInWithPassword({ email, password })` | verify in `insforge-schema-patterns` skill |
| `supabase.auth.onAuthStateChange(cb)` | `client.auth.onSessionChange(cb)` | name differs |
| `supabase.from('t').select('a,b,c')` | `client.database.from('t').select('a,b,c')` | note the `.database` namespace |
| `supabase.from('t').select('*, fk:fk_col(*)')` | same | PostgREST syntax shared |
| `supabase.storage.from(bucket).upload(path, file)` | `client.storage.from(bucket).upload(path, file)` | verify signature |
| `supabase.functions.invoke('fn', { body })` | `client.functions.invoke('fn', { body })` | |
| `supabase.channel('room').on('broadcast', ...)` | **NO DIRECT EQUIVALENT** — InsForge uses webhook-pattern channels; rewrite is app-specific | flag to user |

- [ ] **Step 2: Diagnostic step** — grep the repo for call sites:

```bash
grep -rnE "from '@supabase/supabase-js'|supabase\.auth\.|supabase\.from\(|supabase\.storage\.|supabase\.functions\.|supabase\.channel\(" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" .
```

Count each category; produce a call-site inventory before starting rewrites.

- [ ] **Step 3: Verification** — after rewrite, re-run the same grep; expect zero hits. Plus: TypeScript must compile; app must boot.

- [ ] **Step 4: Commit.**

---

### Task 12: Write the orchestrator `supabase-to-insforge/SKILL.md`

- [ ] **Step 1: Draft SKILL.md**

Structure:

```markdown
---
name: supabase-to-insforge
description: Use when a user wants to migrate an application from Supabase to InsForge. Orchestrates database, auth, storage, edge function, and frontend SDK migration. Invokes child skills in dependency order and produces an inventory report first.
---

# Supabase → InsForge Migration Orchestrator

## When to invoke
User mentions migrating any Supabase project to InsForge, or asks "how do I move off Supabase."

## Inputs required
- Source: `SUPABASE_DB_URL` (read), `SUPABASE_SERVICE_ROLE_KEY` (for private storage, optional)
- Target: `INSFORGE_DB_URL` (direct Postgres write) AND/OR `INSFORGE_API_URL` + `INSFORGE_API_KEY`
- Target frontend repo path (if doing SDK rewrite)

## Step 1 — Produce inventory report
Run the diagnostic probes (exact SQL in each child skill's "Diagnostic probe" section). Print:
- Target model: modern / legacy
- Source: N public tables, N RLS policies, N auth users, N auth identities, N buckets, N storage objects by bucket, N triggers, N public functions
- Frontend: call-site counts per SDK method (invoke `migrate-frontend-sdk` grep step if repo path provided)
- Flags: vault.secrets (manual), realtime (out of scope), supabase.channel usages (manual)

## Step 2 — Recommend execution order
1. migrate-database (schema only)
2. migrate-auth (so FK targets exist)
3. migrate-database (data) — reference repo does these as one step; on modern target split them
4. migrate-storage (buckets first, then objects, then URL rewrite)
5. migrate-edge-functions (if applicable)
6. migrate-frontend-sdk (last — point app at InsForge)

## Step 3 — Dispatch
For each applicable subsystem, invoke the corresponding child skill with the gathered inputs. Wait for user confirmation between steps.

## Step 4 — Post-migration checklist
- [ ] All users can log in
- [ ] Row counts match (tolerate RLS-filtered mismatches — check via service role)
- [ ] Storage objects load in browser for sample keys
- [ ] App loads with InsForge env vars
- [ ] No supabase.co references remain (grep the repo + the DB)
- [ ] Realtime, Vault secrets documented as manual follow-up

## Scope boundary
Orchestration only — never modifies data or code directly. Dispatches to child skills which do the work.
```

- [ ] **Step 2: Commit.**

---

### Task 13: Self-review all 6 skills

Look at the full skill set with fresh eyes.

- [ ] **Step 1: Frontmatter trigger phrases — do they conflict?**

The description field must uniquely identify each skill. Re-read all 6 descriptions. Confirm orchestrator is the entry, children are specific subsystems.

- [ ] **Step 2: Every "Common pitfalls" entry must trace back to a line in `.trial-migration/trial-log.md` (or be clearly flagged as "from reference repo MIGRATION-STATUS.md / README.md", not invented).**

- [ ] **Step 3: Every SQL/shell snippet in every skill must actually run standalone. Do a spot-check by copy-running 3 snippets from each skill against the appropriate connection.**

- [ ] **Step 4: Fix issues inline.** No separate review doc.

---

### Task 14: Repro test — can a fresh reader follow the skills?

Goal: prove the skills document the migration completely.

- [ ] **Step 1: Pretend-fresh-reader pass**

Start at `supabase-to-insforge/SKILL.md`. Follow every instruction literally, without referring back to the trial log or memory. Every command that doesn't work (missing context, ambiguous reference, broken copy-paste) is a bug.

- [ ] **Step 2: Log any issues, fix inline, commit.**

---

### Task 15: Final handoff

- [ ] **Step 1: Write short README in `skills/` directory pointing to the orchestrator.**

```markdown
# Migration Skills

To migrate a Supabase project to InsForge, invoke the `supabase-to-insforge` skill.
See `docs/superpowers/specs/2026-04-13-supabase-to-insforge-skills-design.md` for design rationale.
See `docs/superpowers/research/2026-04-13-trial-log.md` for the grounding trial findings.
```

- [ ] **Step 2: Commit, mark task complete, surface to user.**

---

## Self-review of this plan

**Spec coverage:** Every section of the design spec maps to a task:
- Five skills in the structure → Task 1 (scaffold) + Tasks 7–12 (content)
- Grounded concept map → Task 3 (probe) + Task 4–6 (trial) feed into Tasks 7–12
- Orchestrator responsibilities → Task 12 covers inventory report, recommended ordering, dispatch, post-migration checklist
- Out-of-scope items (vault, realtime, pg_graphql) → called out in orchestrator scope boundary
- Open questions (authenticated role, bcrypt verifier) → answered in Task 3 probe + Task 5 trial

**Placeholders:** None — every skill content section points to specific trial-log sources or reference-repo line numbers.

**Type consistency:** Skill names consistent across all tasks (supabase-to-insforge, migrate-database, migrate-auth, migrate-storage, migrate-edge-functions, migrate-frontend-sdk).

**Drift risk not yet in spec:** The schema drift between reference repo assumptions and modern InsForge is the biggest risk the trial uncovers. Plan bakes this into every child skill as a "Diagnostic probe" + "Decision table" section, not as an afterthought. This is why the diagnostic-first posture is non-negotiable.
