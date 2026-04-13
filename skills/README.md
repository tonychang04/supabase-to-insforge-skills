# Supabase → InsForge Migration Skills

Diagnostic-first skill bundle for migrating applications from Supabase to modern InsForge.

## How to use

Start at the orchestrator:

```
supabase-to-insforge/SKILL.md
```

It runs diagnostic probes against both databases, produces an inventory report, then dispatches to the 5 child skills in dependency order:

1. `migrate-database/` — schema, enums, functions, triggers, RLS policies, data
2. `migrate-auth/` — users + OAuth identities (preserves UUIDs + bcrypt)
3. `migrate-storage/` — buckets, objects, embedded URL rewrites
4. `migrate-edge-functions/` — Deno function port + CLI deploy
5. `migrate-frontend-sdk/` — `@supabase/supabase-js` → `@insforge/sdk` call-site rewrites

## Grounding

Every skill's "Common pitfalls" section is backed by a live trial migration captured in:
- `docs/superpowers/research/2026-04-13-source-schema-analysis.md` — source (35 tables, 16 enums, 4544 rows)
- `docs/superpowers/research/2026-04-13-platform-comparison.md` — component-by-component Supabase vs InsForge
- `docs/superpowers/specs/2026-04-13-supabase-to-insforge-skills-design.md` — design rationale
- `docs/superpowers/plans/2026-04-13-supabase-to-insforge-skills.md` — 15-task implementation plan

Trial result against real creds: 35 tables + 16 enums + 10 functions + 11 triggers + 170 policies applied with 0 errors. Row counts match source exactly. 9 auth users migrated preserving bcrypt. Edge function deployed via CLI + invoked successfully reading migrated data.

## Reference toolkit

For *legacy* InsForge targets (pre-modern schema: `_accounts`, `_storage`), use the reference toolkit directly:
https://github.com/InsForge/supabase-to-insforge

The orchestrator's diagnostic probe tells you whether you have a modern or legacy target.
