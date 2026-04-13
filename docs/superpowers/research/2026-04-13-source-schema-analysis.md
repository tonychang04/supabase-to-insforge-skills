# Source Schema Analysis — Supabase project jnaynuqhbfchrblquaoc

**Date:** 2026-04-13  (grounding evidence for the migration skills)

## Scale
- **35 public tables** · **4,544 rows** (12 populated, 23 empty)
- **16 enum types** · **16 jsonb columns** · **56 FK constraints** · **11 updated_at triggers** · **5 user-defined functions**
- **9 auth.users** · **3 storage buckets** (datarooms 63 private, desktop-releases 19 public, distribution 1 private) · **83 storage objects**

## Identity model — MATTERS FOR THE SKILLS

Central pattern differs from the reference-repo assumptions:

```
auth.users (9 rows, supabase-owned)
    id (uuid)
        ↑  (soft link — NOT a FK constraint)
public.app_profiles (8 rows)
    id (uuid, own gen_random_uuid)        ← FK TARGET for all business tables
    user_id (uuid NOT NULL)                ← references auth.users.id by convention
    name, role, tags, last_used, timestamps
```

Verified: every `app_profiles.user_id` matches an `auth.users.id` (0 orphans).
Verified: `app_profiles.id` **never** equals `auth.users.id` (different UUIDs).

Consequence:
- Reference repo's `REFERENCES auth.users → REFERENCES _accounts` transform is a **no-op** here because zero FKs actually reference `auth.users`.
- What matters is preserving the `app_profiles.user_id ↔ auth.users.id` correspondence, which happens automatically if we preserve UUIDs on the auth-migration side.

## RLS — ports cleanly to modern InsForge

Sampled policies show consistent patterns:

**Simple (most tables):**
```sql
CREATE POLICY deals_select ON deals TO public USING (
  profile_id IN (SELECT id FROM app_profiles WHERE user_id = auth.uid())
);
```

**Org-scoped (exception_cases):**
```sql
CREATE POLICY exception_cases_select_org ON exception_cases TO authenticated USING (
  profile_id IN (SELECT id FROM app_profiles WHERE user_id = auth.uid())
  OR profile_id IN (
    SELECT ap.id FROM app_profiles ap
    JOIN organization_members om ON om.user_id = ap.user_id
    WHERE om.org_id IN (
      SELECT org_id FROM organization_members WHERE user_id = auth.uid()
    )
  )
);
```

Findings:
- `auth.uid()` **exists** on modern InsForge (verified in target probe) — policies port **unchanged**.
- Roles used: `{public}` and `{authenticated}` — must verify `authenticated` is a recognized role on modern InsForge. If not, the skill must either (a) create the role or (b) rewrite `TO authenticated` → `TO public` with an auth-check in the USING clause.
- The reference repo's `auth.uid() → uid()` rewrite is **incorrect** for this target. Skill decision table: if target has `auth.uid()` in search path → leave as-is; else rewrite.

## Enums — 16 types, must be explicitly ported

```
cim_extraction_status, claim_type, claim_verification_status,
deal_status, exception_case_event_type, exception_case_request_status,
exception_case_resolution_action, exception_case_response_type,
exception_case_severity, exception_case_status, impact_status,
job_status, model_source_mode, model_type, remediation_channel,
remediation_request_status
```

`pg_dump --schema-only` emits `CREATE TYPE ... AS ENUM (...)` automatically. Reference repo's `transform-sql.ts` doesn't touch these — they should survive. **Skill verification:** count `CREATE TYPE` statements in output matches source enum count (16).

## Triggers + functions — plpgsql, port unchanged

- `touch_updated_at()` and `touch_exception_case_updated_at()` — identical pattern `NEW.updated_at = now()`; used by 11 triggers on 11 tables.
- `is_org_admin(p_user_id uuid, p_org_id uuid) RETURNS boolean` — `SECURITY DEFINER`, queries `organization_members`.
- `get_user_org_id(p_user_id uuid) RETURNS uuid` — `SECURITY DEFINER`, queries `public.profiles` (note: the 0-row `profiles` table, NOT `app_profiles`). **This means the empty `profiles` table is still load-bearing — skill must NOT skip empty tables.**
- `increment_usage(p_user_id, p_month, p_bytes)` — upsert on `user_usage` table.

## jsonb columns — URL rewrite targets

16 columns across 11 tables contain jsonb. Likely candidates for storage URL references:
- `audit_sessions.summary_stats`, `processing_jobs.storage_paths`, `processing_jobs.result`
- `close_packages.manifest_payload`, `exception_case_responses.attachment_manifest`
- `exception_cases.analysis_payload`, `exception_cases.evidence_payload`
- `claim_verifications.evidence_payload`, `remediation_requests.requested_items`

Reference repo's `update-storage-urls.ts` scans ALL jsonb regardless — so these are covered. Skill should run the universal URL-rewrite pass across all 16 columns after storage migration.

## Storage key shape

```
datarooms/<user-uuid>/<object-uuid>/<filename>
   e.g., datarooms/2dcf9381-.../0235723e-.../data_room.zip
```

Hierarchical, owner-scoped. `storage.objects.owner` = user UUID. InsForge's `storage.objects.uploaded_by` maps directly. Key preservation is critical — reference repo's `encodeStorageKey()` (segment-based URI encoding) is the correct approach.

## What the skills must encode

1. **Diagnostic-first** — probe both sides; don't assume reference repo's transforms apply.
2. **Handle enums** — verify `CREATE TYPE` statements survive transform + load.
3. **Preserve `user_id` soft-link** in `app_profiles` rather than trying to make it a FK.
4. **RLS port rule** — if `auth.uid()` exists on target → leave policies unchanged.
5. **Migrate empty tables too** — they may be function-dependencies (`profiles` is used by `get_user_org_id()`).
6. **URL rewrite scope** — universal jsonb scan, not hard-coded columns.
7. **Role verification** — check if `authenticated` role exists on target; adapt policies if not.

## Open verification items (for the trial run)

- Does `authenticated` role exist on modern InsForge? (Test: `SELECT 1 FROM pg_roles WHERE rolname='authenticated'`)
- Does `pg_dump --schema=public` from Supabase 17+ include the enum `CREATE TYPE` statements needed?
- Does `auth.users` on modern InsForge have a unique `(email)` constraint that collides with duplicates on insert? (Shouldn't — source has unique emails — but confirm.)
- Does the InsForge database user `postgres` have permission to `CREATE TYPE ... AS ENUM` in public schema?
