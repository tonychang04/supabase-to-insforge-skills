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

**This is the exact sequence that worked in trial 2026-04-13** — ported 19 public-bucket objects (99 MB) successfully. Copy verbatim; substitute your values.

List source objects:

```bash
export PGPASSWORD='<supabase-password>'
mkdir -p storage-dl
psql "$SUPABASE_DB_URL" -t -A -F '|' -c "
  SELECT o.bucket_id, o.name FROM storage.objects o
  JOIN storage.buckets b ON b.id=o.bucket_id
  ORDER BY b.public DESC, o.bucket_id, o.name
" > objects.list
wc -l objects.list
```

Download. Public buckets use unauthenticated URL; private require `SUPABASE_SERVICE_ROLE_KEY`:

```bash
# Get bucket visibility upfront so we know which auth to use per object
psql "$SUPABASE_DB_URL" -t -A -c "SELECT id, public FROM storage.buckets" \
  | awk -F'|' '{print $1"="$2}' > bucket-visibility.sh
source bucket-visibility.sh  # exports e.g. datarooms=f, desktop-releases=t, distribution=f

while IFS='|' read bucket key; do
  [ -z "$key" ] && continue
  local_path="storage-dl/$bucket/$key"
  mkdir -p "$(dirname "$local_path")"
  # encode each path segment separately; keep '/' as separator
  encoded=$(python3 -c "import sys,urllib.parse as u; print('/'.join(u.quote(s, safe='') for s in sys.argv[1].split('/')))" "$key")
  # pick endpoint based on bucket visibility
  eval "is_public=\$$bucket"
  if [ "$is_public" = "t" ]; then
    url="$SUPABASE_URL/storage/v1/object/public/$bucket/$encoded"
    http=$(curl -sf -o "$local_path" -w '%{http_code}' "$url")
  else
    url="$SUPABASE_URL/storage/v1/object/$bucket/$encoded"
    http=$(curl -sf -o "$local_path" -w '%{http_code}' -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" "$url")
  fi
  printf '%s %10s  %s/%s\n' "$http" "$(stat -f%z "$local_path" 2>/dev/null || echo 0)" "$bucket" "$key"
done < objects.list | tee download.log
```

Verify: `du -sh storage-dl/` and inspect the 200/non-200 distribution in `download.log`.

Alternative for very large buckets: the reference repo's `npm run export:storage` uses the Supabase JS client (pagination + resume + manifest).

### 3. Upload objects to target preserving exact keys

**Verified working flow from trial 2026-04-13** — uploaded 19 objects (99 MB) with exact key preservation:

```bash
# Ensure CLI is linked to the target project
npx @insforge/cli link --project-id <project-id>

find storage-dl -type f | while read local_path; do
  rel="${local_path#storage-dl/}"               # e.g., desktop-releases/folder/file.exe
  bucket="${rel%%/*}"                           # desktop-releases
  key="${rel#$bucket/}"                         # folder/file.exe
  npx @insforge/cli storage upload "$local_path" --bucket "$bucket" --key "$key" 2>&1 | tail -1
done | tee upload.log
```

Expected output per object: `✓ Uploaded "<key>" to bucket "<bucket>".`

The CLI handles segment encoding, chunked upload, Bearer auth, and retries — preferred over raw curl.

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
psql "$INSFORGE_DB_URL" -c "
  SELECT bucket, count(*), pg_size_pretty(sum(size)) AS total_size
  FROM storage.objects GROUP BY bucket ORDER BY 1;
"
```

Expected: row per bucket with count + size matching source.

Sample URL test (public bucket) — expect HTTP 302 redirect to a signed CDN URL:

```bash
curl -sI "$INSFORGE_BASE_URL/api/storage/buckets/<bucket>/objects/<key>"
# HTTP/2 302
# location: https://cdn.insforge.dev/storage/<app-key>/<bucket>/<key>?Expires=...&Signature=...
```

**Important:** the API URL returns a 302 redirect to a CDN with a signed URL. Browsers handle this transparently; `<img src>` / `<a href>` work fine. Server-side fetches must follow redirects (`curl -L`).

URL-rewrite sanity: every jsonb column that had `%supabase.co/storage%` before should have 0 matches after Step 4:

```bash
psql "$INSFORGE_DB_URL" -c "
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND data_type='jsonb';
"
# Then for each (t, c):
# SELECT count(*) FROM <t> WHERE <c>::text LIKE '%supabase.co/storage%';
# Expected: 0 everywhere.
```

## Common pitfalls (from trial 2026-04-13 — 19 objects, 99 MB migrated successfully)

- **Skipping bytes entirely**: creating bucket rows via SQL without running the download/upload flow means objects don't exist on target — `SELECT count(*) FROM storage.objects` stays at 0 even though `storage.buckets` has rows. Steps 2 + 3 are mandatory.
- **`cdn.insforge.dev` redirect**: public object URLs return 302 to a signed CDN URL with short-lived `Expires`/`Signature` query params. Browsers and `curl -L` follow fine; code that caches raw bytes of the API-URL response instead of the final URL will 302-cache and break when the signature expires.

- **Wrong InsForge instance via MCP**: The `mcp__insforge__*` tools (including create-bucket) may point at a different InsForge project than the user's target DB. Always use direct SQL and the user-provided API URL/key.
- **Private bucket without service role key**: no way to download object bytes. If user hasn't provided `SUPABASE_SERVICE_ROLE_KEY`, ask — do not proceed silently.
- **Key encoding: slashes MUST NOT be encoded**: encode each segment separately. `encodeURIComponent("folder/file name.jpg")` → `"folder%2Ffile%20name.jpg"` = WRONG (slash is a path separator). Correct → `"folder/file%20name.jpg"`.
- **File size limits**: InsForge may reject very large files (50 MB+ in the dataroom-style buckets observed in trial). Surface failures to user; consider splitting or excluding.
- **Duplicate `(1).jpg` suffixes on re-upload**: if target bucket already has the key from a previous run, upload may produce collision-renamed keys. The reference repo includes cleanup SQL for this case.
- **`storage.objects.owner` uuid**: Supabase tracks owner; InsForge tracks `uploaded_by`. HTTP upload sets it based on the authenticated API key's subject — you cannot easily preserve original owners. Document this; if owner matters for RLS, `app_profiles.user_id` typically holds the authoritative link anyway.
- **jsonb URL rewrite regex must use character classes carefully**: `[^"\\]+` in the rewrite is important — without it the pattern may run past the JSON value boundary.

## Scope boundary

Covers: buckets, objects, embedded URL rewrites. Does NOT cover: signed-URL expiry configuration, CDN setup, bucket-level RLS policies on `storage.objects` (InsForge's storage.* schema handles this internally), custom MIME-type allowlists (not a bucket-level setting on InsForge).
