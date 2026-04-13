---
name: migrate-edge-functions
description: Use when migrating Supabase Edge Functions (Deno TS files) to modern InsForge Functions. Rewrites imports, handler shape, env vars, and SDK client init; deploys via raw HTTP API (stateless, automation-friendly). The DB row alone does not activate the runtime — deploy is mandatory.
---

# Migrate Edge Functions (Supabase → modern InsForge)

## When to invoke

- Orchestrator dispatched to this skill
- Source repo contains `supabase/functions/<fn-name>/index.ts`
- Database + auth migration complete

## When NOT to invoke

- No edge functions in source
- Function uses `auth.admin.createSession/generateLink` → requires human rewrite
- Function uses `supabase.channel(...).on(...)` → not portable

## Inputs required

```
Source repo path                # contains supabase/functions/*
INSFORGE_BASE_URL               # e.g., https://<app-key>.<region>.insforge.app
INSFORGE_API_KEY                # ik_... project_admin key
```

All deploy ops are stateless HTTP against `INSFORGE_BASE_URL` with the Bearer token — no CLI install or login required.

**If you need the CLI (e.g., for debugging cold-start errors — see below), the authentication flow has a non-obvious first step:**

1. Open the InsForge dashboard for the target project in a browser.
2. Click the **"Connect"** button in the top-right of the dashboard header — this opens a modal with a one-time connect command that authenticates the CLI to this specific project.
3. Copy that command (typically `npx @insforge/cli login` followed by `npx @insforge/cli link --project-id <id>`) and run it in your terminal.

Without this connect step, `npx @insforge/cli functions deploy ...` fails with "No project linked" or 401. Once connected, the `.insforge/project.json` is populated in the current directory and all CLI ops work.

**Exception — keep `@insforge/cli` around for debugging cold-start crashes.** The raw-HTTP deploy response reports `deployment.status: success` as soon as the DB row is written, but *does not wait for the runtime to successfully load the module*. If module-level code throws (see "Common pitfalls"), the DB shows `status: active` and `deployedAt: <now>`, but the function runtime returns 404 at invoke time. The CLI's `functions deploy` command surfaces the actual runtime exception (with file:line from the Deno loader):

```
Error: Missing API key. Pass it to the constructor `new Resend("re_123")`
    at file:///src/functions/send-org-invite.ts:18:16
Error: Function deployment failed
```

So: use raw HTTP for the migration script itself, but if any function returns 404 at invoke-time despite `status: active`, redeploy the same file via `npx @insforge/cli functions deploy <slug> --file <path>` to see the real error. (Interactive `supabase login`-style flow is not required for InsForge CLI deploy once the project is linked; you can also re-read logs via `/api/logs/function-deploy.logs` if exposed.)

## Canonical function format (verified against live runtime 2026-04-13)

- **Default-export handler ONLY**: `export default async function handler(req: Request): Promise<Response> { ... }`
- Deploy validator rejects any file containing the literal string `Deno.serve` — **including in comments and docstrings** (the validator is a literal regex, not a TS parser). Strip all mentions.
- **SDK import**: `import { createClient } from 'npm:@insforge/sdk@latest'` (use `npm:` scheme, not `jsr:`)
- **Client construction**: `createClient({ baseUrl, anonKey })` — not `new Insforge({apiUrl, apiKey})`
- **Reserved env vars auto-provided in function runtime** (verified via `GET /api/secrets`):
  - `INSFORGE_BASE_URL` — public URL
  - `INSFORGE_INTERNAL_URL` — in-cluster URL (lower latency, prefer when available)
  - `API_KEY` — project_admin
  - `ANON_KEY` — anonymous JWT

## Diagnostic probe

### Step 0 — CRITICAL: discover ALL deployed source functions

**Supabase Edge Functions source code is NOT stored in the Postgres database** (verified against a live Supabase Cloud instance 2026-04-13 — no `functions` schema, no functions bucket in `storage.buckets`, no `code`/`source` columns anywhere). It lives on Supabase's separate Deno runtime.

**The local repo is NOT authoritative.** Functions can be deployed directly via `supabase functions deploy` without committing source. You MUST compare the deployed list to the repo.

Get the deployed list (three ways, in order of preference):

```bash
# Option A: Supabase CLI (requires login + project ref)
supabase login                                          # opens browser for access token
supabase link --project-ref <supabase-project-ref>      # e.g., jnaynuqhbfchrblquaoc
supabase functions list                                 # print table of deployed functions
supabase functions download <slug>                      # pulls source to supabase/functions/<slug>/

# Option B: Supabase dashboard
#   Project → Edge Functions → click each → "Download"

# Option C: rewrite from scratch
#   If you can't retrieve source, infer the contract from frontend call sites and DB triggers.
#   Grep the frontend:   grep -rnE "functions\.invoke\(['\"][^'\"]+"
#   Grep Supabase auth config in dashboard for email/invite hooks that point at a function.
```

Then scan the source:

```bash
ls <repo>/supabase/functions/
# Local list MUST match the deployed list. Any function deployed but missing from repo
# = must be downloaded or rewritten before this skill can port it.
for fn in <repo>/supabase/functions/*/; do
  echo "=== $fn ==="
  grep -rE "from ['\"].*@supabase/supabase-js|Deno\.env\.get|serve\(|supabase\.auth\.admin|supabase\.channel\(|supabase\.rpc" "$fn"
done
```

For each function: capture env vars used, SDK methods called, flag `auth.admin.*` / `channel()` for manual.

### Step 0a — Probe target

```bash
API_URL="$INSFORGE_BASE_URL"
KEY="$INSFORGE_API_KEY"

# List existing functions on target
curl -sS -H "Authorization: Bearer $KEY" "$API_URL/api/functions"

# List existing secrets on target (reserved + user-added)
curl -sS -H "Authorization: Bearer $KEY" "$API_URL/api/secrets"
```

## Rewrite rules (apply mechanically per function)

| Supabase | InsForge |
|---|---|
| `import { serve } from "https://deno.land/std@.../http/server.ts"` | _remove_ |
| `import { createClient } from "https://esm.sh/@supabase/supabase-js@2"` | `import { createClient } from 'npm:@insforge/sdk@latest'` |
| `serve(async (req) => { ... })` | `export default async function handler(req: Request): Promise<Response> { ... }` |
| `Deno.env.get("SUPABASE_URL")` | `Deno.env.get("INSFORGE_INTERNAL_URL") ?? Deno.env.get("INSFORGE_BASE_URL")` |
| `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` | `Deno.env.get("API_KEY")` |
| `Deno.env.get("SUPABASE_ANON_KEY")` | `Deno.env.get("ANON_KEY")` |
| `createClient(url, key, opts)` | `createClient({ baseUrl, anonKey })` |
| `supabase.from(t).select(...)` | `client.database.from(t).select(...)` |
| `supabase.from(t).insert({...})` | `client.database.from(t).insert([{...}])` — **array wrap required** |
| `supabase.storage.from(b).upload(...)` | `client.storage.from(b).upload(...)` |
| `supabase.functions.invoke("fn")` | `client.functions.invoke("fn")` |
| `new Response(JSON.stringify(x), { headers: { "Content-Type": "application/json" }})` | `Response.json(x)` |

Do NOT auto-rewrite, flag to user: `auth.admin.createSession/generateLink`, `supabase.channel(...)`, custom `supabase.rpc(...)` calls.

## Procedure

### 1. Rewrite each source file

For `supabase/functions/<fn>/index.ts`, produce `.migration-out/<fn>.ts`. Use this template:

```typescript
// Do NOT include the literal "Deno.serve" anywhere (even comments) — validator rejects it.
import { createClient } from 'npm:@insforge/sdk@latest';

const client = createClient({
  baseUrl: Deno.env.get('INSFORGE_INTERNAL_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? '',
  anonKey: Deno.env.get('API_KEY') ?? '',
});

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const body = req.method === 'GET' ? null : await req.json();
    // ... logic
    return Response.json({ ok: true /* , data */ });
  } catch (err: any) {
    return Response.json({ error: err.message ?? String(err) }, { status: 500 });
  }
}
```

### 2. Upload required secrets (raw HTTP)

Auto-provided (DO NOT re-add): `INSFORGE_BASE_URL`, `INSFORGE_INTERNAL_URL`, `API_KEY`, `ANON_KEY`.

Re-enter every OTHER secret the source function read via `Deno.env.get`. Supabase stored these in project settings — user supplies values:

```bash
API_URL="$INSFORGE_BASE_URL"
KEY="$INSFORGE_API_KEY"

add_secret() {
  curl -sS -X POST "$API_URL/api/secrets" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "{\"key\":\"$1\",\"value\":\"$2\"}"
  echo
}

add_secret "RESEND_API_KEY" "re_xxx..."
add_secret "SEND_EMAIL_HOOK_SECRET" "whsec_xxx..."
add_secret "SITE_URL" "https://trystet.com"
add_secret "FROM_EMAIL" "STET <noreply@trystet.com>"

# Verify:
curl -sS -H "Authorization: Bearer $KEY" "$API_URL/api/secrets" | jq '.secrets[].key'
```

Response on success: `{"success":true,"message":"Secret X has been created successfully","id":"..."}`.

Update existing secret (if key already there):
```bash
curl -sS -X PUT "$API_URL/api/secrets/<KEY_NAME>" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"value":"new-value"}'
```

### 3. Deploy each function (raw HTTP POST)

```bash
deploy_fn() {
  local slug="$1" name="$2" desc="$3" file="$4"
  # Use jq or a Python heredoc to JSON-encode the source code safely
  payload=$(python3 -c "
import json, sys
print(json.dumps({
  'slug': sys.argv[1],
  'name': sys.argv[2],
  'description': sys.argv[3],
  'code': open(sys.argv[4]).read()
}))" "$slug" "$name" "$desc" "$file")
  curl -sS -X POST "$API_URL/api/functions" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d "$payload"
  echo
}

deploy_fn "send-email" "Send Email" "Transactional auth emails via Resend" ".migration-out/send-email.ts"
deploy_fn "sso-callback" "SSO Callback" "SAML/OIDC callback handler"       ".migration-out/sso-callback.ts"
```

Expected response: `{"success":true,"function":{...},"deployment":{"id":"...","status":"success","url":"..."}}`.

**Create vs update semantics (verified 2026-04-13):**
- `POST /api/functions` returns **409 `ALREADY_EXISTS`** if slug exists — it does NOT upsert.
- `PUT /api/functions/<slug>` updates an existing function (same body, minus slug).
- Safe idempotent pattern: POST first; on 409, retry as PUT.

```bash
deploy_or_update() {
  local slug="$1" file="$2" name="$3" desc="$4"
  payload=$(python3 -c "
import json, sys
print(json.dumps({
  'slug': sys.argv[1],
  'name': sys.argv[2],
  'description': sys.argv[3],
  'code': open(sys.argv[4]).read()
}))" "$slug" "$name" "$desc" "$file")
  # Try create
  resp=$(curl -sS -X POST "$API_URL/api/functions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "$payload")
  if echo "$resp" | grep -q '"ALREADY_EXISTS"'; then
    # Fall back to update
    curl -sS -X PUT "$API_URL/api/functions/$slug" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$payload"
  else
    echo "$resp"
  fi
  echo
}
```

**Validator error you will hit if your file contains `Deno.serve` anywhere:**
```
Error: Functions should use "export default async function(req: Request)" instead of "Deno.serve()". The router handles serving automatically.
```
Grep your file (`grep -n 'Deno\.serve\|serve(' .migration-out/<fn>.ts`) and remove every occurrence, including comments and template strings.

### 4. Verify deployment

```bash
# Function metadata
curl -sS -H "Authorization: Bearer $KEY" "$API_URL/api/functions/<slug>" | jq '{slug,name,status,deployedAt}'

# Invoke via function URL (different host: functions.insforge.app)
FN_HOST="${API_URL/us-east.insforge.app/functions.insforge.app}"  # adjust pattern for your region
# Or compute from appkey: https://<appkey>.functions.insforge.app
curl -sS "$FN_HOST/<slug>"
curl -sS -X POST -H "Content-Type: application/json" -d '{"test":true}' "$FN_HOST/<slug>"
```

Expected function-URL pattern:
```
Supabase:  https://<ref>.supabase.co/functions/v1/<slug>
InsForge:  https://<app-key>.functions.insforge.app/<slug>   ← no region, no /api prefix
```

### 5. Coordinate with `migrate-frontend-sdk`

Frontend `supabase.functions.invoke('<slug>')` → `client.functions.invoke('<slug>')`. SDK computes the function URL from `baseUrl` automatically — no manual URL construction needed.

## HTTP API reference (verified 2026-04-13 against live runtime)

```
GET    /api/functions                      # list
GET    /api/functions/<slug>                # fetch one (includes code)
POST   /api/functions                       # create/upsert: {slug, name, description, code}
PUT    /api/functions/<slug>                # update (same body, minus slug)
DELETE /api/functions/<slug>                # remove

GET    /api/secrets                         # list (metadata only, values hidden)
GET    /api/secrets/<key>                   # get decrypted value (requires admin)
POST   /api/secrets                         # create: {key, value, isReserved?, expiresAt?}
PUT    /api/secrets/<key>                   # update: {value}
DELETE /api/secrets/<key>                   # remove

All require  Authorization: Bearer <project_admin_ik_...>
Base URL:    https://<app-key>.<region>.insforge.app
```

## Common pitfalls (from trial 2026-04-13 porting stet's send-email)

- **`Deno.serve` rejected — even in comments**: validator is a literal regex scanner. Occurrence in a block comment explaining "CLI rejects `Deno.serve(...)`" caused deploy failure. Strip every mention.
- **CLI state dependence**: `@insforge/cli` requires `link` to populate `<cwd>/.insforge/project.json`. Breaks mid-migration when scripts cd into subdirs or when automation runs in a different working directory. **Raw HTTP avoids all this** — stateless per-request.
- **SDK source**: `jsr:@insforge/sdk` does NOT exist. Use `npm:@insforge/sdk@latest`.
- **Env var rename**: older examples use `ACCESS_API_KEY`; current is `API_KEY`. Confirmed via `GET /api/secrets` listing `INSFORGE_BASE_URL, INSFORGE_INTERNAL_URL, API_KEY, ANON_KEY` as reserved auto-provided.
- **`baseUrl` with hardcoded `http://insforge:7130`**: old examples. That DNS does not resolve on current cloud runtime. Use env-fallback chain `INSFORGE_INTERNAL_URL ?? INSFORGE_BASE_URL`.
- **Empty `anonKey` silently permitted at construction**: `createClient({ anonKey: '' })` returns a client; all requests then 401 with `AUTH_INVALID_CREDENTIALS: No token provided`. Always `?? ''` + log a warning if resolved to empty.
- **Insert not array-wrapped**: PostgREST dialect requires `insert([{...}])`. Supabase was lenient; InsForge strict.
- **Missing 3rd-party secrets**: `Deno.env.get("RESEND_API_KEY")` returns undefined if secret wasn't added. Function's own startup validators (common pattern) will return 503 "not configured" — which is CORRECT behavior, but looks like a deploy problem. Check `GET /api/secrets` before blaming the deploy.
- **`service_role` bypass semantics**: source function assumed `service_role` bypasses RLS. `API_KEY` (project_admin) is subject to RLS. Rely on `migrate-database`'s admin bypass policies (added by default) or explicit `client.database.sql(...)` calls.
- **SSO/SAML callbacks**: functions like stet's `sso-callback` that mint Supabase sessions via `supabase.auth.admin.createSession` cannot be auto-ported. Surface to user; rewrite requires understanding InsForge's current session API.
- **JSON-encoding function source safely**: embedding multi-line TypeScript in a shell heredoc risks quote/escape breakage. Prefer `python3 -c "import json,sys; print(json.dumps({..., 'code': open(sys.argv[N]).read()}))"` or `jq -n --arg code "$(cat file.ts)" '{code: $code, ...}'`.

## Scope boundary

Covers: per-function rewrite, raw-HTTP secret + deploy + verify flow. Does NOT cover: shared `supabase/functions/_shared/*` modules (inline into each function or flag to user), custom CORS/rate-limit tuning, function-specific domains, function invocation tracing/observability setup.
