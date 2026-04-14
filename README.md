# Supabase → InsForge Migration Skills

A diagnostic-first skill bundle for Claude (and any agent) to migrate applications from [Supabase](https://supabase.com) to [InsForge](https://insforge.dev). Every procedure in this bundle was walked end-to-end against a real production-shape Supabase project and a real InsForge target; every "Common pitfalls" entry traces to a specific failure actually hit during the trial.

---

## TL;DR — what this repo contains

```
skills/                        # 6 Claude skills
├── README.md                   # skill-bundle index + credentials checklist
├── supabase-to-insforge/       # orchestrator — probe both sides, dispatch
├── migrate-database/           # schema + data via pg_dump + direct psql
│   └── transform.sh            # tested shell transform (run on real dump)
├── migrate-auth/               # users + OAuth identities (UUID + bcrypt preserved)
├── migrate-storage/            # buckets + objects + URL rewrite in jsonb
├── migrate-edge-functions/     # Deno function rewrite + raw-HTTP deploy
└── migrate-frontend-sdk/       # @supabase/supabase-js → @insforge/sdk + AST script

docs/superpowers/
├── specs/                      # design rationale
├── plans/                      # 15-task implementation plan
└── research/                   # live-probed schema + platform comparison
```

## Verified end-to-end result (2026-04-13 trial)

| Layer | Source | Target | Status |
|---|---|---|---|
| Database | 35 public tables, 16 enums, 10 functions, 11 triggers, 135 RLS policies | + 35 admin-bypass policies | 0 errors on apply |
| Data | 4,544 rows across 12 populated tables | exact row-count match | verified |
| Auth users | 9 users with bcrypt hashes | UUIDs + bcrypt preserved | login works |
| Storage buckets | 3 (1 public / 2 private) | 3 | created via HTTP |
| Storage objects (public) | 19 files (99 MB) | served via CloudFront+S3 | verified |
| Edge functions | `send-email`, `sso-callback`, `send-org-invite` | all `active` status | invocations return expected business logic |
| Frontend (stet Next.js app) | 30 files using `@supabase/*` | `@insforge/sdk` | **`npm run build` green, 1776 tests pass** |

The stet frontend migration landed as PR [SritejBommaraju/stet#9](https://github.com/SritejBommaraju/stet/pull/9).

---

## How to use these skills

### Option 1 — from Claude Code

Point Claude at `skills/` and invoke the orchestrator:

```
/skill supabase-to-insforge
```

The orchestrator's diagnostic probe decides whether your target InsForge is modern (has `auth.users` schema) or legacy (has `_accounts` table), then dispatches to the right child skills in dependency order.

### Option 2 — read the skill files directly

Each `SKILL.md` is self-contained, with:
- **When to invoke / when NOT to**
- **Inputs required** (credentials checklist)
- **Diagnostic probe** (copy-paste SQL / curl to understand target state)
- **Decision table** (map probe output to strategy)
- **Procedure** (verbatim commands, verified)
- **Verification** (queries to prove it worked)
- **Common pitfalls** (every failure hit during the trial, with fix)
- **Scope boundary** (what the skill does NOT cover)

Start at `skills/README.md` for the credentials checklist (you need source Supabase + target InsForge URLs and keys).

---

## Highest-value findings (mined during the trial)

These are the things docs didn't tell me — every one was learned the hard way.

### Database

- **`pg_dump` emits functions before tables.** Triggers that reference those functions fail. Fix: extract all `CREATE FUNCTION` blocks and reinject before the first `CREATE TRIGGER`/`CREATE POLICY` (not just before policies — triggers come first). `skills/migrate-database/transform.sh` does this via awk.
- **Supabase qualifies pgcrypto as `extensions.gen_random_bytes`.** InsForge has pgcrypto in `public`. Must rewrite every occurrence; unqualified fallback doesn't resolve during DDL.
- **`DROP SCHEMA public CASCADE` wipes role grants.** Must restore `GRANT USAGE TO anon, authenticated, project_admin` + `ALTER DEFAULT PRIVILEGES`. Forgetting this breaks HTTP API access silently.
- **`project_admin` does NOT bypass RLS** (unlike Supabase's `service_role`). Every RLS-enabled table needs an explicit admin-bypass policy. The reference repo's transform does this automatically; if you roll your own, don't forget.

### Auth

- **Password bcrypt hashes port directly.** Supabase `$2a$`/`$2b$` hashes written to InsForge's `auth.users.password` column preserve user passwords — users log in with the same credentials.
- **UUIDs must be preserved.** If you create users via the HTTP API instead of direct SQL INSERT, IDs regenerate and every FK to `auth.users.id` breaks.
- **`auth.identities` with `provider='email'` are redundant** with `auth.users.password` on InsForge — do NOT migrate them. Only OAuth identities go to `auth.user_providers`.

### InsForge SDK surface gaps vs Supabase

From reading `node_modules/@insforge/sdk/dist/index.d.ts` directly:

| Supabase pattern | InsForge status | Workaround |
|---|---|---|
| `auth.getUser()` | → `getCurrentUser()` | rename |
| `auth.getSession()` | absent | use `getCurrentUser()` + read token from localStorage for custom headers |
| `auth.onAuthStateChange(cb)` | **absent** | poll via `visibilitychange` + explicit refresh on sign-in/out |
| `auth.admin.*` (createUser, createSession, deleteUser, ...) | no `admin` namespace | admin client + direct `.database.from('auth.users')` |
| `auth.updateUser({password})` | absent | `sendResetPasswordEmail` → `exchangeResetPasswordToken` (2-step UX) |
| `auth.resetPasswordForEmail(email, opts)` | → `sendResetPasswordEmail({email, ...opts})` | rename + arg shape |
| `auth.signUp({options:{data}})` | → `signUp({name})` + follow-up `setProfile` | two calls |
| `type User`, `type Session` | → `UserSchema`, `AuthSession` | re-export |
| Session fields `access_token`, `refresh_token`, etc. | camelCase (`accessToken`, ...) | rename |
| User fields `email_confirmed_at`, `created_at`, `user_metadata`, `app_metadata` | `emailVerified` (bool), `createdAt`, `metadata`, `profile` | rename |

### Storage

- Cookie for SSR refresh is named exactly **`insforge_refresh_token`** (underscore, not dash). Verified via live login probe — assumptions about prefix-matching kick users out silently.
- Public bucket URLs return **HTTP 302 to CloudFront** with a signed CDN URL. Browsers + `curl -L` follow fine; code that caches raw bytes of the API-URL response breaks on signature expiry.

### Edge functions

- **Deploy validator regex-matches `Deno.serve` even in comments.** Literal scanner, not TS parser. Strip every mention (even docstrings warning against it).
- **Raw-HTTP `POST /api/functions` returns `deployment.status: success` too eagerly** — it writes the DB row but doesn't wait for runtime load. If the function throws at module-top-level (e.g., `new Resend(undefined)`), the function URL returns 404 while the DB says `status: active`. Use lazy construction inside the handler; always smoke-test invoke after deploy.
- Canonical function format: `export default async function handler(req: Request): Promise<Response>` — **not** `Deno.serve(...)`, which the CLI rejects.

### Tooling

- **macOS BSD `sed` does NOT support `\b` word boundaries.** For identifier renames (like `supabase` → `insforge`), use `perl -i -pe 's/\bX\bY/g'`.
- **sed can't rewrite multi-line method chains** like `receiver\n    .method(...)`. For any non-trivial rewrite, use ts-morph. The working AST script is in `skills/migrate-frontend-sdk/SKILL.md`; it did 92 `.from()` + 19 `.insert()` rewrites on stet automatically.
- **`.insert({...})` → `.insert([{...}])`** (array wrap) cannot be done safely by regex. InsForge's PostgREST dialect is strict; Supabase was lenient. Use the AST script.
- **Build is the only authoritative "done" signal.** `npm run build` exit code 0 is mandatory before claiming the migration works.

---

## What does NOT auto-migrate

The orchestrator's post-migration checklist surfaces these as manual follow-ups:

- **Realtime channels** (`supabase.channel(...)`) — different architecture, manual rewrite.
- **Supabase Vault secrets** — must be re-entered via `POST /api/secrets` (encrypted at rest, not copyable).
- **MFA factors**, **SSO/SAML providers** — re-enrollment / re-configuration.
- **`auth.admin.createSession` / SSO callbacks** — substantial rewrite; session model differs.
- **pg_graphql queries** in the frontend — rewrite to PostgREST/SDK.
- **Active Supabase JWTs** — invalid after cutover; users re-authenticate.
- **OAuth access/refresh tokens** — not exposed in source DB; users re-authorize on first sign-in.

---

## For legacy InsForge targets

If your target is a pre-modern InsForge instance (has `_accounts` instead of `auth.users`), use the reference TypeScript toolkit directly:

https://github.com/InsForge/supabase-to-insforge

These skills are built for modern targets and the orchestrator's probe tells you which you have.

---

## Reference links

- Trial source Supabase project: jnaynuqhbfchrblquaoc (STET due-diligence app)
- Trial target InsForge project: `kx9jfb7d.us-east.insforge.app` (STET AI)
- Live PR on stet: https://github.com/SritejBommaraju/stet/pull/9
- Reference migration toolkit: https://github.com/InsForge/supabase-to-insforge
- This repo: https://github.com/tonychang04/supabase-to-insforge-skills

---

## License

MIT. Fork freely; PRs with new pitfalls welcomed — add them to the relevant skill's "Common pitfalls" section with a date and a one-line description of the failure mode you hit.
