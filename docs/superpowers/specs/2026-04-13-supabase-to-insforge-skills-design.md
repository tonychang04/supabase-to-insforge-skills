# Supabase → InsForge Migration Skills — Design

**Date:** 2026-04-13
**Status:** Approved pending spec review
**Author:** Claude (brainstorming session with user)

## Goal

Produce a reusable bundle of Claude skills that guide future Claude instances through migrating any Supabase project to InsForge. Replaces a prior one-shot script approach (since deleted) with durable, composable skills.

Secondary: execute a live sample migration against user-provided credentials to ground every skill in real friction, not docs.

## Non-goals

- Not a generic "migrate from any Postgres-as-a-service" tool — Supabase-specific assumptions are allowed.
- Not migrating realtime or Supabase GraphQL (different mental models; out of scope).
- Not porting Supabase Vault secrets (manual step — flag in orchestrator report).

## Deliverable

Five skills in `/Users/gary/projects/test4/skills/`:

```
skills/
├── supabase-to-insforge/        # orchestrator — entry point
├── migrate-database/            # schema + data + RLS policies
├── migrate-auth/                # auth.users + identities → auth.users + user_providers
├── migrate-storage/             # buckets + objects
├── migrate-edge-functions/      # Deno fn files → InsForge functions.definitions rows
└── migrate-frontend-sdk/        # @supabase/supabase-js → @insforge/sdk call-site rewrites
```

Each child skill is independently invocable. The orchestrator produces an inventory report, then walks the user through children in dependency order.

## Grounded concept map

Verified against the live DBs during brainstorming.

| Concept | Supabase | InsForge | Migration action |
|---|---|---|---|
| `auth.users` columns | 35 (phone, MFA, SSO, SAML, email_change\_\*, recovery\_\*, etc.) | 10 (id, email, password, email_verified, profile, metadata, is_project_admin, is_anonymous, timestamps) | Map `encrypted_password`→`password`, `raw_user_meta_data`→`metadata`, `raw_app_meta_data`→merge into `profile`, drop phone/MFA/SSO/SAML columns |
| Password hash | bcrypt (`$2a$`/`$2b$`) | bcrypt | **Direct copy** preserves login continuity (to be verified in trial) |
| `auth.uid()` | exists | exists ✅ | RLS policies using `auth.uid()` port unchanged |
| `auth.identities` (OAuth) | 1 row per linked provider | `auth.user_providers` | Shape-map: `provider_id`→`provider_account_id`, keep user_id, flatten `identity_data` JSON |
| Schemas to drop | `graphql`, `graphql_public`, `vault`, `realtime`, `supabase_migrations`, `pgbouncer` | — | strip from dump |
| Extensions to swap | `uuid-ossp` | `pgcrypto` | rewrite `uuid_generate_v4()` → `gen_random_uuid()` |
| `storage.buckets` columns | `id, name, public, file_size_limit, allowed_mime_types, owner` | `name, public, created_at, updated_at` | Enforce size/mime in app layer — not bucket metadata |
| `storage.objects` columns | `id, bucket_id, name, owner, metadata, path_tokens, version` | `bucket, key, size, mime_type, uploaded_at, uploaded_by` | `bucket_id`→`bucket`, `name`→`key`; re-upload content (can't just copy rows — bytes live in object store) |
| Triggers (`*_updated_at` plpgsql) | user-defined | compatible | port functions + triggers as-is |
| Edge functions | `.ts` files on disk, deployed via `supabase functions deploy` | rows in `functions.definitions(code text)` | Rewrite imports + handler shape, deploy via MCP `create-function` |
| Frontend SDK | `@supabase/supabase-js` | `@insforge/sdk` | PostgREST query syntax is largely compatible; auth/storage call shapes differ |

Two open verification items (done during the trial migration):
1. Is `authenticated` a valid GRANT target role in InsForge, or is `TO authenticated` supabase-only syntax?
2. Does InsForge accept Supabase's bcrypt hashes directly at login?

## Source project inventory (the sample we'll use)

Real numbers from the Supabase read-only connection:

- **35 public tables**, all RLS-enabled, 2–9 policies each (114 policies total)
- **11 `updated_at` triggers**
- **9 auth.users**, 83 storage objects across 3 buckets (`datarooms` private 63, `desktop-releases` public 19, `distribution` private 1)
- Extensions: `pg_graphql`, `pgcrypto`, `supabase_vault`, `uuid-ossp`

The trial migration uses this data, against the InsForge write-credential database.

## Skill anatomy (applies to all 5 children)

Each SKILL.md contains, in order:

1. **Frontmatter** — `name`, `description` (with trigger phrases — when to invoke), and if relevant `allowed-tools`.
2. **When to invoke** — concrete trigger signals.
3. **Inputs required** — the caller must supply (e.g., source/target connection strings, bucket names, function directory).
4. **Procedure** — numbered steps with the exact SQL / shell / code to run.
5. **Verification** — queries to prove each step worked.
6. **Common pitfalls** — concrete failures hit during the trial, with fixes.
7. **When NOT to invoke / scope boundary**.

## Orchestrator responsibilities

`supabase-to-insforge/SKILL.md` is the only one that makes decisions across the full migration. It:

1. Takes source + target credentials.
2. Produces an **inventory report**: table list, policy count per table, extension list, bucket list + object count, `supabase/functions/*/` directory scan, grep results for `@supabase/supabase-js` call sites in the target repo.
3. Prints a **recommended ordering** (database → auth → storage → functions → frontend).
4. For each step, tells the user which child skill to invoke and what inputs to pass.
5. Surfaces items that need human review: `vault.secrets`, realtime channels, Supabase GraphQL usage, custom SQL functions with supabase-internal dependencies.

The orchestrator does not perform migrations itself — it coordinates.

## Testing plan

The spec is considered implemented when:

1. All 5 skills have `SKILL.md` files.
2. A trial migration of the real Supabase source against the real InsForge target runs end-to-end using *only* the skills as instructions (i.e., a reader could reproduce it).
3. The inventory report printed by the orchestrator matches reality (35 tables, 9 users, 83 storage objects, 3 buckets).
4. Known friction points encountered during the trial are captured in the "Common pitfalls" section of the relevant skill.

## Out of scope for v1

- Supabase Vault → InsForge secrets (flag only).
- Realtime (different model; separate future skill).
- pg_graphql (deprecated approach; move to PostgREST).
- Two-way sync / blue-green cutover strategies.
- Rollback tooling (document the theory, don't build it).

## Open questions (to resolve during implementation)

- Whether InsForge's bcrypt verifier accepts all bcrypt cost factors Supabase might have written.
- Whether `auth.user_providers` needs pre-existing rows in `auth.custom_oauth_configs` for OAuth identities to work.
- Whether direct SQL INSERT into `auth.users` (bypassing the gotrue-equivalent API) is sanctioned by InsForge — or if all user creation must go through SDK.
