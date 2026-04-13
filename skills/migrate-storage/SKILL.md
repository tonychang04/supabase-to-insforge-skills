---
name: migrate-storage
description: Use when migrating Supabase Storage buckets and objects to modern InsForge storage. Creates buckets via SQL, downloads object bytes from source, uploads to target via HTTP API preserving exact keys, then runs a universal regex URL rewrite across all jsonb columns to fix embedded references.
---

# Migrate Storage (Supabase → modern InsForge)

## When to invoke

- Orchestrator dispatched to this skill
- `migrate-database` and `migrate-auth` complete (URL rewrite target tables exist, owner UUIDs resolve)

## When NOT to invoke

- No buckets in source (`SELECT count(*) FROM storage.buckets` = 0)
- User only wants metadata rewrite without actually copying bytes → skip to Step 4 only

## Inputs required

```
SUPABASE_DB_URL                 # postgresql://postgres.<ref>:<pw>@<pooler>:6543/postgres
SUPABASE_URL                    # https://<ref>.supabase.co (for public bucket downloads)
SUPABASE_SERVICE_ROLE_KEY       # required for PRIVATE bucket object downloads
INSFORGE_DB_URL                 # postgresql://postgres:<pw>@<host>:5432/insforge?sslmode=require
INSFORGE_API_URL                # e.g. https://<host>.insforge.app
INSFORGE_API_KEY                # project_admin key for Bearer auth on uploads
```

## Diagnostic probe

```bash
export PGPASSWORD='<supabase-password>'
psql "$SUPABASE_DB_URL" <<'SQL'
\echo === source buckets ===
SELECT id, name, public, file_size_limit FROM storage.buckets;
\echo === source object counts + sizes ===
SELECT bucket_id, count(*), pg_size_pretty(sum((metadata->>'size')::bigint)) AS total FROM storage.objects GROUP BY bucket_id;
\echo === sample keys per bucket (to see shape) ===
SELECT DISTINCT ON (bucket_id) bucket_id, name FROM storage.objects ORDER BY bucket_id, name LIMIT 10;
\echo === jsonb columns that might contain URLs ===
SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='jsonb' ORDER BY 1,2;
SQL
```

```bash
export PGPASSWORD='<insforge-password>'
psql "$INSFORGE_DB_URL" -c "SELECT name, public FROM storage.buckets ORDER BY name;"
```

Decision: for each source bucket not in target, plan creation. Public source bucket → public target bucket (same).

## Procedure

### 1. Create target buckets

**Preferred path: `@insforge/cli`.** Link project first (`npx @insforge/cli link --project-id <id>`), then:

```bash
# For each source bucket:
npx @insforge/cli storage create-bucket <bucket-name> --public    # public=true
npx @insforge/cli storage create-bucket <bucket-name>             # public=false (default)
npx @insforge/cli storage buckets
```

**Fallback — direct SQL** (use only when CLI unavailable; DO NOT use `mcp__insforge__create-bucket` unless you've verified the MCP targets this same project):

```bash
export PGPASSWORD='<insforge-password>'
psql "$INSFORGE_DB_URL" <<'SQL'
INSERT INTO storage.buckets (name, public) VALUES
  ('<bucket1>', true),
  ('<bucket2>', false)
ON CONFLICT (name) DO UPDATE SET public = EXCLUDED.public;
SELECT name, public FROM storage.buckets ORDER BY name;
SQL
```

### 2. Download source objects

Public buckets — download via unauthenticated URL:

```bash
mkdir -p storage-downloads
psql "$SUPABASE_DB_URL" -t -A -c "SELECT o.bucket_id, o.name FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id WHERE b.public=true ORDER BY o.bucket_id, o.name" | while IFS='|' read bucket key; do
  local_path="storage-downloads/$bucket/$key"
  mkdir -p "$(dirname "$local_path")"
  curl -sfL -o "$local_path" "$SUPABASE_URL/storage/v1/object/public/$bucket/$key" && echo "OK $bucket/$key" || echo "FAIL $bucket/$key"
done
```

Private buckets — require service role key:

```bash
psql "$SUPABASE_DB_URL" -t -A -c "SELECT o.bucket_id, o.name FROM storage.objects o JOIN storage.buckets b ON b.id=o.bucket_id WHERE b.public=false ORDER BY o.bucket_id, o.name" | while IFS='|' read bucket key; do
  local_path="storage-downloads/$bucket/$key"
  mkdir -p "$(dirname "$local_path")"
  curl -sfL -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
       -o "$local_path" "$SUPABASE_URL/storage/v1/object/$bucket/$key" \
    && echo "OK $bucket/$key" || echo "FAIL $bucket/$key"
done
```

Alternatively, for large buckets, use the reference repo's Node-based downloader: `npm run export:storage` in github.com/InsForge/supabase-to-insforge — uses `@supabase/supabase-js` storage client which handles pagination, resumable downloads, and manifest creation.

### 3. Upload objects to target preserving exact keys

**Preferred path: `@insforge/cli`.** Link to project first: `npx @insforge/cli link --project-id <id>`, then:

```bash
find storage-downloads -type f | while read local_path; do
  rel="${local_path#storage-downloads/}"        # bucket/key/path/file.ext
  bucket="${rel%%/*}"
  key="${rel#$bucket/}"
  npx @insforge/cli storage upload "$local_path" --bucket "$bucket" --key "$key" \
    && echo "OK $bucket/$key" || echo "FAIL $bucket/$key"
done
```

The CLI handles segment encoding, chunked upload, Bearer auth, and retries. Preferred over raw curl.

**Fallback — raw HTTP PUT with key encoding** (use when CLI unavailable):

```bash
# Critical encoding rule: each path segment URL-encoded separately so '/' stays as a separator.
find storage-downloads -type f | while read local_path; do
  rel="${local_path#storage-downloads/}"; bucket="${rel%%/*}"; key="${rel#$bucket/}"
  encoded_key=$(python3 -c "import sys,urllib.parse as u; print('/'.join(u.quote(s, safe='') for s in sys.argv[1].split('/')))" "$key")
  http_code=$(curl -sf -o /dev/null -w '%{http_code}' -X PUT \
    -H "Authorization: Bearer $INSFORGE_API_KEY" \
    -F "file=@$local_path" \
    "$INSFORGE_API_URL/api/storage/buckets/$bucket/objects/$encoded_key")
  echo "$http_code $bucket/$key"
done
```

(For very large buckets with Node.js infrastructure, the reference repo's `storage/import-storage.ts` provides additional resumability.)

### 4. Universal URL rewrite across all jsonb columns

Source URLs embedded in jsonb (from probe Step 0):
```
FROM: https://<source-ref>.supabase.co/storage/v1/object/public/{bucket}/{key}
TO:   {INSFORGE_API_URL}/api/storage/buckets/{bucket}/objects/{key}
```

Generate UPDATE statements for every jsonb column in public schema:

```bash
export PGPASSWORD='<insforge-password>'
psql "$INSFORGE_DB_URL" -t -A -c "
SELECT format(
  'UPDATE public.%I SET %I = regexp_replace(%I::text, ''https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/([^/]+)/([^\"\\\\]+)'', ''$INSFORGE_API_URL/api/storage/buckets/\\1/objects/\\2'', ''g'')::jsonb WHERE %I::text LIKE ''%%supabase.co/storage%%'';',
  table_name, column_name, column_name, column_name
) FROM information_schema.columns WHERE table_schema='public' AND data_type='jsonb';
" | grep -v '^$' > url-rewrite.sql

cat url-rewrite.sql  # review before applying
psql "$INSFORGE_DB_URL" -v ON_ERROR_STOP=0 -f url-rewrite.sql
```

Also rewrite any text/varchar columns known to store URLs — check by grepping schema:

```bash
psql "$INSFORGE_DB_URL" -c "
SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND data_type IN ('text','character varying')
    AND column_name ~ '_url$|^url$';
"
```

For each match, run the same regexp_replace update, adapted.

## Verification

```bash
psql "$INSFORGE_DB_URL" <<'SQL'
\echo === bucket + object counts ===
SELECT b.name, b.public, count(o.key) AS objects
  FROM storage.buckets b LEFT JOIN storage.objects o ON o.bucket=b.name
  GROUP BY b.name, b.public ORDER BY b.name;
\echo === any supabase URLs remaining? ===
SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND data_type='jsonb';
-- Run a sample check on the biggest jsonb columns:
-- SELECT count(*) FROM <table> WHERE <col>::text LIKE '%supabase.co/storage%';
SQL
```

Compare bucket + object counts to source. Sampled `%supabase.co/storage%` count should be 0 everywhere after Step 4.

Browser sanity check: pick a sample public bucket object, visit `$INSFORGE_API_URL/api/storage/buckets/<bucket>/objects/<key>` — should serve the content.

## Common pitfalls (from trial 2026-04-13)

- **Wrong InsForge instance via MCP**: The `mcp__insforge__*` tools (including create-bucket) may point at a different InsForge project than the user's target DB. Always use direct SQL and the user-provided API URL/key.
- **Private bucket without service role key**: no way to download object bytes. If user hasn't provided `SUPABASE_SERVICE_ROLE_KEY`, ask — do not proceed silently.
- **Key encoding: slashes MUST NOT be encoded**: encode each segment separately. `encodeURIComponent("folder/file name.jpg")` → `"folder%2Ffile%20name.jpg"` = WRONG (slash is a path separator). Correct → `"folder/file%20name.jpg"`.
- **File size limits**: InsForge may reject very large files (50 MB+ in the dataroom-style buckets observed in trial). Surface failures to user; consider splitting or excluding.
- **Duplicate `(1).jpg` suffixes on re-upload**: if target bucket already has the key from a previous run, upload may produce collision-renamed keys. The reference repo includes cleanup SQL for this case.
- **`storage.objects.owner` uuid**: Supabase tracks owner; InsForge tracks `uploaded_by`. HTTP upload sets it based on the authenticated API key's subject — you cannot easily preserve original owners. Document this; if owner matters for RLS, `app_profiles.user_id` typically holds the authoritative link anyway.
- **jsonb URL rewrite regex must use character classes carefully**: `[^"\\]+` in the rewrite is important — without it the pattern may run past the JSON value boundary.

## Scope boundary

Covers: buckets, objects, embedded URL rewrites. Does NOT cover: signed-URL expiry configuration, CDN setup, bucket-level RLS policies on `storage.objects` (InsForge's storage.* schema handles this internally), custom MIME-type allowlists (not a bucket-level setting on InsForge).
