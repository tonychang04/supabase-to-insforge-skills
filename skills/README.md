# Supabase → InsForge Migration Skills

Diagnostic-first skill bundle for migrating applications from Supabase to modern InsForge.

---

## Before you start — gather these credentials

Collect everything below BEFORE running any skill. Missing values block specific steps (noted in brackets).

### Source (Supabase)

| Variable | Where to get it | Needed for |
|---|---|---|
| `SUPABASE_DB_URL` | Dashboard → Project Settings → Database → Connection string → **Transaction pooler** | all skills (read-only) |
| `SUPABASE_URL` | Dashboard → Project Settings → API → Project URL | migrate-storage (public bucket downloads) |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard → Project Settings → API → `service_role secret` | migrate-storage (private bucket downloads) |
| Frontend repo path | the app that uses `@supabase/supabase-js` | migrate-frontend-sdk |
| `supabase/functions/` path in source repo | typical: `<repo>/supabase/functions/` | migrate-edge-functions |

### Target (InsForge)

| Variable | Where to get it | Needed for |
|---|---|---|
| `INSFORGE_DB_URL` | Dashboard → Project → Settings → Database → Connection string (direct) | migrate-database, migrate-auth |
| `INSFORGE_BASE_URL` | Dashboard → Project → Overview (format: `https://<app-key>.<region>.insforge.app`) | migrate-storage, migrate-edge-functions, migrate-frontend-sdk |
| `INSFORGE_API_KEY` | Dashboard → Project → Settings → API → **API Key** (starts with `ik_`) | migrate-storage (uploads), migrate-edge-functions (deploy, secrets) |
| `INSFORGE_ANON_KEY` | Dashboard → Project → Settings → API → **Anon Key** (JWT) | migrate-frontend-sdk (public client) |

### Format quick-reference

```bash
# Source
SUPABASE_DB_URL="postgresql://postgres.<ref>:<pw>@<region>.pooler.supabase.com:6543/postgres"
SUPABASE_URL="https://<ref>.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="eyJhbGc..."

# Target
INSFORGE_DB_URL="postgresql://postgres:<pw>@<host>:5432/insforge?sslmode=require"
INSFORGE_BASE_URL="https://<app-key>.<region>.insforge.app"
INSFORGE_API_KEY="ik_..."
INSFORGE_ANON_KEY="eyJhbGc..."
```

### Tools installed locally

| Tool | Command | Used by |
|---|---|---|
| PostgreSQL client 17+ | `psql --version` | all skills |
| `pg_dump` 17+ | `pg_dump --version` (matches source server version) | migrate-database |
| `curl` | standard | all skills (raw HTTP) |
| `python3` | standard on macOS/Linux | migrate-storage (URL segment encoding) |
| `jq` (optional) | `jq --version` | prettier output |
| Node.js 20+ (optional) | only if you prefer `@insforge/cli` for interactive use | none mandatory |

**No InsForge CLI login/link is required** — all skills use raw HTTP with the `INSFORGE_API_KEY` for stateless, automation-friendly calls.

---

## How to run

Start at the orchestrator:

```
supabase-to-insforge/SKILL.md
```

It runs diagnostic probes against both databases, produces an inventory report, then dispatches to the 5 child skills in dependency order:

1. **migrate-database** — schema, enums, functions, triggers, RLS policies, data (via `pg_dump` + direct `psql`)
2. **migrate-auth** — users + OAuth identities (preserves UUIDs + bcrypt hashes)
3. **migrate-storage** — buckets, objects, URL rewrites (raw HTTP upload/download)
4. **migrate-edge-functions** — Deno function rewrite + raw HTTP deploy + secrets
5. **migrate-frontend-sdk** — `@supabase/supabase-js` → `@insforge/sdk` call-site rewrite

Each child skill is independently invocable — you can run just one if that's all you need.

---

## Dependency order

```
migrate-database (schema)
      │
      ▼
migrate-auth           ← users must exist before data load (FK integrity)
      │
      ▼
migrate-database (data)
      │
      ▼
migrate-storage (buckets → objects → URL rewrite in jsonb)
      │
      ▼
migrate-edge-functions (depends on DB + auth existing)
      │
      ▼
migrate-frontend-sdk   ← last: points the app at InsForge
```

---

## What does NOT auto-migrate (flagged by orchestrator)

- **Realtime channels** (`supabase.channel(...)`) — different architecture, manual rewrite required
- **Supabase Vault secrets** (`vault.secrets`) — must be re-entered (encrypted at rest, not copyable)
- **MFA factors** (`auth.mfa_*`) — users must re-enroll
- **SSO/SAML providers** (`auth.sso_*`, `auth.saml_*`) — manual reconfiguration
- **pg_graphql** queries in the frontend — rewrite to PostgREST/SDK
- **Active JWT sessions** — InsForge signs tokens with its own key; users re-authenticate
- **OAuth refresh/access tokens** — Supabase doesn't expose them in DB; users re-authorize

---

## Grounding

Every pitfall documented in the skills is backed by a live trial migration against real Supabase + InsForge credentials on 2026-04-13. The trial moved:

- 35 tables + 16 enum types + 10 functions + 11 triggers + 170 policies (135 source + 35 admin bypass)
- 4,544 rows (counts match source exactly)
- 9 auth users with bcrypt hashes preserved
- 3 storage buckets created
- 19 public storage objects (99 MB) uploaded to CloudFront+S3 backend
- Test edge function deployed via raw HTTP POST to `/api/functions`, invoked successfully, read from migrated `app_profiles`

Supporting research in `docs/superpowers/`:
- `specs/2026-04-13-supabase-to-insforge-skills-design.md` — design rationale
- `plans/2026-04-13-supabase-to-insforge-skills.md` — 15-task implementation plan
- `research/2026-04-13-source-schema-analysis.md` — deep-dive of source (app_profiles identity model, enum inventory, FK graph)
- `research/2026-04-13-platform-comparison.md` — component-by-component Supabase vs InsForge

---

## Reference toolkit

For *legacy* InsForge targets (pre-modern schema: `_accounts`, `_storage`), use the TypeScript reference toolkit directly:
https://github.com/InsForge/supabase-to-insforge

The orchestrator's diagnostic probe (`has_auth_users` vs `has_legacy_accounts`) tells you whether you have a modern or legacy target. These skills assume modern.

---

## InsForge HTTP API quick reference (verified 2026-04-13)

All endpoints require `Authorization: Bearer <ik_...>` and respond with JSON.

```
# Functions
GET    /api/functions                         # list
GET    /api/functions/<slug>                   # fetch one (includes code)
POST   /api/functions                          # create: {slug, name, description, code}
PUT    /api/functions/<slug>                   # update
DELETE /api/functions/<slug>                   # remove

# Secrets (env vars for functions)
GET    /api/secrets                            # list (values hidden)
GET    /api/secrets/<key>                       # get value (admin)
POST   /api/secrets                             # add: {key, value, isReserved?, expiresAt?}
PUT    /api/secrets/<key>                       # update: {value}
DELETE /api/secrets/<key>                       # remove

# Storage
GET    /api/storage/buckets                     # list
POST   /api/storage/buckets                     # create: {bucketName, isPublic}
DELETE /api/storage/buckets/<name>              # remove (cascades objects)
PUT    /api/storage/buckets/<b>/objects/<key>    # upload: multipart file
GET    /api/storage/buckets/<b>/objects/<key>    # download (302 → signed CDN URL for public buckets)
```

Function invocation URL uses a different host pattern:
```
https://<app-key>.functions.insforge.app/<slug>
```
