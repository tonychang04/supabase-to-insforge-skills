---
name: migrate-auth
description: Use when migrating Supabase auth.users (and optionally auth.identities for OAuth) to modern InsForge auth.users + auth.user_providers. Preserves UUIDs (critical for FK integrity) and bcrypt password hashes (users keep their existing passwords).
---

# Migrate Auth (Supabase → modern InsForge)

## When to invoke

- Orchestrator dispatched to this skill
- `migrate-database` schema load complete (tables exist, RLS policies exist)
- BEFORE `migrate-database` data load — user rows must exist before public.* data with FK-ish references

## When NOT to invoke

- Legacy InsForge target (`_accounts` instead of `auth.users`) → use reference toolkit
- Source uses MFA / SSO / SAML / webauthn — those tables are not portable; surface to user

## Inputs required

```
SUPABASE_DB_URL      # postgresql://postgres.<ref>:<pw>@<pooler>:6543/postgres
INSFORGE_DB_URL      # postgresql://postgres:<pw>@<host>:5432/insforge?sslmode=require
```

## Diagnostic probe

```bash
export PGPASSWORD='<supabase-password>'
psql "$SUPABASE_DB_URL" -c "
SELECT
  (SELECT count(*) FROM auth.users) AS source_users,
  (SELECT count(*) FROM auth.users WHERE encrypted_password IS NOT NULL) AS with_password,
  (SELECT count(*) FROM auth.users WHERE is_anonymous) AS anonymous_users,
  (SELECT count(*) FROM auth.identities) AS source_identities,
  (SELECT count(*) FROM auth.mfa_factors) AS mfa_factors,
  (SELECT count(*) FROM auth.sso_providers) AS sso_providers;
"
```

Decision:
- `mfa_factors > 0` → warn user: MFA factors will NOT migrate; users with MFA will have to re-enroll.
- `sso_providers > 0` → warn user: SSO config must be re-entered in InsForge manually.
- `source_identities` where `provider <> 'email'` → these are OAuth linkages; preserve as `auth.user_providers` rows.
- `source_identities` where `provider = 'email'` → skip. These are redundant with `auth.users.password` on InsForge.

```bash
export PGPASSWORD='<insforge-password>'
psql "$INSFORGE_DB_URL" -c "
SELECT column_name, data_type, is_nullable FROM information_schema.columns
  WHERE table_schema='auth' AND table_name='users' ORDER BY ordinal_position;
"
```

**Expected modern shape:** `id, email, password, email_verified, created_at, updated_at, profile, metadata, is_project_admin, is_anonymous` (10 columns). If the column set differs (e.g., new required column added), STOP — surface to user.

## Procedure

### 1. Export users as upsertable INSERT statements (preserves UUIDs + bcrypt)

```bash
export PGPASSWORD='<supabase-password>'
psql "$SUPABASE_DB_URL" -t -A -c "
SELECT format(
  'INSERT INTO auth.users (id, email, password, email_verified, created_at, updated_at, metadata, profile, is_anonymous) VALUES (%L, %L, %L, %L, %L, %L, %L, %L, %L) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, password=EXCLUDED.password, metadata=EXCLUDED.metadata, profile=EXCLUDED.profile, updated_at=EXCLUDED.updated_at;',
  id, email, encrypted_password,
  (email_confirmed_at IS NOT NULL)::boolean,
  created_at, updated_at,
  COALESCE(raw_user_meta_data, '{}'::jsonb),
  COALESCE(raw_app_meta_data, '{}'::jsonb),
  is_anonymous
) FROM auth.users ORDER BY created_at;
" > auth-import.sql
wc -l auth-import.sql  # should equal source_users count
```

Column mapping:
| Supabase `auth.users` | InsForge `auth.users` | Notes |
|---|---|---|
| `id` (uuid) | `id` (uuid) | **preserve** — FK integrity depends on it |
| `email` | `email` | |
| `encrypted_password` | `password` | bcrypt `$2a$`/`$2b$` — **direct copy**, users keep passwords |
| `email_confirmed_at IS NOT NULL` | `email_verified` (boolean) | |
| `raw_user_meta_data` (jsonb) | `metadata` (jsonb) | |
| `raw_app_meta_data` (jsonb) | `profile` (jsonb) | |
| `is_anonymous` | `is_anonymous` | |
| `created_at, updated_at` | same | |
| `phone, email_change_*, recovery_*, confirmation_*, banned_until, reauthentication_*, *_token*` | — | dropped; not supported in InsForge core |

### 2. Apply to target

```bash
export PGPASSWORD='<insforge-password>'
psql "$INSFORGE_DB_URL" -v ON_ERROR_STOP=0 -f auth-import.sql 2>&1 | tail -10
```

Every line should be `INSERT 0 1`.

### 3. Migrate OAuth identities (skip if all source identities are `email`)

```bash
export PGPASSWORD='<supabase-password>'
psql "$SUPABASE_DB_URL" -t -A -c "
SELECT format(
  'INSERT INTO auth.user_providers (id, user_id, provider, provider_account_id, provider_data, created_at, updated_at) VALUES (gen_random_uuid(), %L, %L, %L, %L, %L, %L) ON CONFLICT DO NOTHING;',
  user_id, provider, provider_id,
  COALESCE(identity_data, '{}'::jsonb),
  created_at, updated_at
) FROM auth.identities WHERE provider <> 'email' ORDER BY created_at;
" > identities-import.sql

export PGPASSWORD='<insforge-password>'
psql "$INSFORGE_DB_URL" -v ON_ERROR_STOP=0 -f identities-import.sql 2>&1 | tail -5
```

**NOTE:** Supabase `auth.identities` does not store OAuth access/refresh tokens — only the linkage. `auth.user_providers.access_token` / `refresh_token` stay NULL. **Users will have to re-authorize** on their first sign-in after migration.

## Verification

```bash
psql "$INSFORGE_DB_URL" -c "
SELECT count(*) AS total,
       count(*) FILTER (WHERE password LIKE '\$2%') AS with_bcrypt,
       count(*) FILTER (WHERE email_verified) AS verified,
       count(*) FILTER (WHERE is_anonymous) AS anon
FROM auth.users;
"
```

Expected: `total` ≥ source_users. (May be higher if target had pre-existing users — e.g., the InsForge admin account.)

```bash
# Cross-check a specific source user exists on target with same UUID + bcrypt prefix
psql "$SUPABASE_DB_URL" -c "SELECT id, email, LEFT(encrypted_password, 7) AS bcp FROM auth.users ORDER BY created_at LIMIT 1;"
psql "$INSFORGE_DB_URL"  -c "SELECT id, email, LEFT(password, 7)           AS bcp FROM auth.users WHERE email = '<that-email>';"
```

Both rows should show: same `id`, same `email`, same `bcp` (e.g., `$2a$10$`).

## Common pitfalls (from trial 2026-04-13)

- **UUID regeneration**: if you use InsForge's auth HTTP API (`POST /api/auth/users`) instead of direct SQL, new IDs are generated and every FK in your public schema breaks. **Always use direct SQL INSERT** with ON CONFLICT to preserve IDs.
- **Source email identities are redundant**: Supabase creates a row in `auth.identities` for email signups too (`provider='email', provider_id=<email>`). Do NOT migrate these to `auth.user_providers` — that table is for OAuth only. Filter `WHERE provider <> 'email'`.
- **Password hash verification**: bcrypt hashes from Supabase (`$2a$`/`$2b$`) work on InsForge as-is. If you see a hash with a different prefix (e.g., `$argon2`), the source is using a custom hashing plugin and direct copy won't work — surface to user.
- **Active sessions die**: InsForge signs JWTs with its own key, so Supabase-minted JWTs are invalid immediately. Active sessions fail to renew. Plan the cutover when user impact is acceptable.
- **`app_metadata` vs `user_metadata` convention**: Supabase uses `raw_app_meta_data` for admin-set data (role, provider) and `raw_user_meta_data` for user-editable. This skill maps `raw_app_meta_data → profile` and `raw_user_meta_data → metadata`. If your app reads these via SDK, your frontend code will need matching reads — document the split to the user.
- **Anonymous users**: Supabase has `is_anonymous=true` users; InsForge has the same flag. Preserve directly.

## Scope boundary

Does not cover: MFA factors, SSO/SAML providers, one-time tokens, webauthn credentials, refresh tokens, sessions, audit_log_entries. All of those either don't migrate (MFA/webauthn) or don't survive platform change (sessions/JWT). Flag to user as manual follow-ups.
