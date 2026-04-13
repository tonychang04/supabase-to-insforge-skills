---
name: migrate-edge-functions
description: Use when migrating Supabase Edge Functions (Deno TS files) to modern InsForge Functions. Rewrites imports, handler shape, env vars, and SDK client init; deploys via the @insforge/cli (the DB row alone does not activate the runtime — actual deploy is required).
---

# Migrate Edge Functions (Supabase → modern InsForge)

## When to invoke

- Orchestrator dispatched to this skill
- Source repo contains `supabase/functions/<fn-name>/index.ts`
- Database + auth migration complete

## When NOT to invoke

- No edge functions in source
- Function uses `auth.admin.createSession/generateLink` (session minting) → requires human rewrite
- Function uses `supabase.channel(...).on(...)` (realtime) → not portable
- Node-only APIs → surface, don't auto-port

## Inputs required

```
Source repo path                # contains supabase/functions/*
InsForge project-id             # UUID from dashboard
# Auto-provided by InsForge runtime (do NOT hardcode):
#   INSFORGE_INTERNAL_URL       # for same-cluster calls from function
#   INSFORGE_BASE_URL           # public URL
#   API_KEY                     # project_admin key
#   ANON_KEY                    # anonymous JWT
```

## Prerequisites

```bash
npm i -g @insforge/cli           # or use npx ad-hoc
npx @insforge/cli login
npx @insforge/cli link --project-id <project-id>
npx @insforge/cli current        # verify linked project
npx @insforge/cli secrets list   # should show INSFORGE_BASE_URL, INSFORGE_INTERNAL_URL, API_KEY, ANON_KEY (auto-provided)
```

## Diagnostic probe

```bash
ls <repo>/supabase/functions/
# For each fn:
grep -rE "from ['\"].*@supabase/supabase-js|Deno\.env\.get|serve\(|supabase\.auth\.admin|supabase\.channel\(|supabase\.rpc" <repo>/supabase/functions/<fn>/
```

Flag for manual review: `auth.admin.*`, `channel(...)`, anything SSO/SAML-related.

Target state:
```bash
npx @insforge/cli functions list
```

## Canonical InsForge function format (verified against live runtime)

**Must use `export default async function handler(req: Request): Promise<Response>`.**
Do NOT use `Deno.serve(...)` — the CLI explicitly rejects it with:
> `Error: Functions should use "export default async function(req: Request)" instead of "Deno.serve()". The router handles serving automatically.`

**SDK import:** `import { createClient } from 'npm:@insforge/sdk@latest'` (NOT `jsr:`).

**Client setup:**
```typescript
const client = createClient({
  baseUrl: Deno.env.get('INSFORGE_INTERNAL_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? '',
  anonKey: Deno.env.get('API_KEY') ?? '',   // admin-level inside function (project_admin)
});
```

Prefer `INSFORGE_INTERNAL_URL` for in-cluster latency. Fall through to `INSFORGE_BASE_URL` for cross-cluster.
Use `API_KEY` (project_admin) when the function needs to bypass the caller's RLS. Use `ANON_KEY` + forwarded user JWT when the function should execute as the caller.

## Procedure

### 1. Rewrite each function

For each `supabase/functions/<fn>/index.ts`, produce `.migration-out/<fn>.ts` using this template:

```typescript
// Verified working canonical InsForge function format (trial 2026-04-13)
import { createClient } from 'npm:@insforge/sdk@latest';

// Initialize client once at module load — reused across invocations
const client = createClient({
  baseUrl: Deno.env.get('INSFORGE_INTERNAL_URL') ?? Deno.env.get('INSFORGE_BASE_URL') ?? '',
  anonKey: Deno.env.get('API_KEY') ?? '',    // project_admin — bypasses per-user RLS
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
    // ... your logic, calling client.database.from(t).select/insert/update/delete(...)
    // ... or client.auth.admin.*, client.storage.from(b).*, etc.
    return Response.json({ ok: true /* , data */ });
  } catch (err: any) {
    return Response.json({ error: err.message ?? String(err) }, { status: 500 });
  }
}
```

**Rewrite rules:**

| Supabase | InsForge | Notes |
|---|---|---|
| `import { serve } from "https://deno.land/std@.../http/server.ts"` | _remove_ | No `serve()` — router handles it |
| `import { createClient } from "https://esm.sh/@supabase/supabase-js@2"` | `import { createClient } from 'npm:@insforge/sdk@latest'` | `npm:` scheme, not `jsr:` |
| `serve(async (req) => {...})` | `export default async function handler(req: Request): Promise<Response> {...}` | default-export ONLY; CLI rejects `Deno.serve` |
| `Deno.env.get("SUPABASE_URL")` | `Deno.env.get("INSFORGE_INTERNAL_URL") ?? Deno.env.get("INSFORGE_BASE_URL")` | auto-provided reserved env |
| `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` | `Deno.env.get("API_KEY")` | auto-provided, project_admin |
| `Deno.env.get("SUPABASE_ANON_KEY")` | `Deno.env.get("ANON_KEY")` | auto-provided |
| `createClient(url, key, opts)` | `createClient({ baseUrl, anonKey })` | object-param signature |
| `supabase.from(t).select(...)` | `client.database.from(t).select(...)` | `.database` namespace |
| `supabase.from(t).insert({...})` | `client.database.from(t).insert([{...}])` | **array wrap required** |
| `supabase.storage.from(b).upload(...)` | `client.storage.from(b).upload(...)` | |
| `supabase.functions.invoke("fn")` | `client.functions.invoke("fn")` | |
| `supabase.rpc("fn", {...})` | verify current shape with `npx @insforge/cli docs db-sdk` before rewriting | |
| `new Response(JSON.stringify(x), { headers: { "Content-Type": "application/json" }})` | `Response.json(x)` | Deno native |

**Do NOT auto-rewrite, flag to user:**
- `supabase.auth.admin.createSession(...)` / `generateLink(...)` — session model differs
- `supabase.channel(...)` — realtime not portable
- `supabase.rpc(...)` returning non-primitive types — shape may differ

### 2. Deploy via CLI (real deploy, not SQL)

**The function runtime requires actual deploy. A row in `functions.definitions` alone does NOT serve it — verified during trial.**

```bash
npx @insforge/cli functions deploy <slug> \
  --file .migration-out/<slug>.ts \
  --name "<Display Name>" \
  --description "<Short description>"
```

Expected success:
```
✓ Function "<slug>" creation success.
  Deployment: success → https://<app-key>.functions.insforge.app
```

### 3. Add any 3rd-party secrets the source function used

Auto-provided (do NOT re-add): `INSFORGE_BASE_URL`, `INSFORGE_INTERNAL_URL`, `API_KEY`, `ANON_KEY`.

Re-enter every other secret (Supabase stored these in project settings — user must supply values):

```bash
npx @insforge/cli secrets add SENDGRID_API_KEY "<value>"
npx @insforge/cli secrets add STRIPE_SECRET_KEY "<value>"
npx @insforge/cli secrets add SITE_URL "https://..."
# ...
npx @insforge/cli secrets list
```

### 4. Verify each deployed function

```bash
# Smoke test each slug
curl -sS "https://<app-key>.functions.insforge.app/<slug>"     # GET default
# POST:
curl -sS -X POST \
  -H "Content-Type: application/json" \
  -d '{"test":true}' \
  "https://<app-key>.functions.insforge.app/<slug>"
# Logs if something's off:
npx @insforge/cli logs function.logs --tail
npx @insforge/cli logs function-deploy.logs --tail
```

### 5. Coordinate with `migrate-frontend-sdk`

Frontend invocation URL changes:

```
Supabase:  https://<ref>.supabase.co/functions/v1/<slug>
InsForge:  https://<app-key>.functions.insforge.app/<slug>
```

Prefer rewriting frontend calls to `client.functions.invoke('<slug>')` — SDK computes the URL automatically from `baseUrl` config.

## Common pitfalls (from trial 2026-04-13)

- **`Deno.serve()` wrapper rejected**: CLI deploy errors with `Functions should use "export default async function(req: Request)" instead of "Deno.serve()"`. Default export is mandatory.
- **Validator matches `Deno.serve` in COMMENTS too**: the deploy-time regex scanner does NOT parse TypeScript — any literal occurrence of `Deno.serve` in a comment or string anywhere in the file triggers rejection. Strip all mentions from code comments, docstrings, and template strings before deploying. Observed 2026-04-13: a block comment explaining "CLI rejects `Deno.serve(...)`" caused deploy failure even though no actual `Deno.serve(` call existed.
- **Wrong SDK source**: `jsr:@insforge/sdk` does NOT exist (as of verification). Use `npm:@insforge/sdk@latest`.
- **Wrong baseUrl pattern**: older examples show `http://insforge:7130` — this DNS name does not resolve on current cloud runtime. Use `Deno.env.get('INSFORGE_INTERNAL_URL')` with a fallback to `INSFORGE_BASE_URL`.
- **Wrong env var name**: older examples show `ACCESS_API_KEY` — the current reserved name is `API_KEY`. Verified via `secrets list` showing `API_KEY, ANON_KEY, INSFORGE_BASE_URL, INSFORGE_INTERNAL_URL` all auto-provided.
- **Empty `anonKey` silently permitted**: if `Deno.env.get('API_KEY')` is undefined, `createClient({ anonKey: '' })` still constructs a client, but all requests 401 with `AUTH_INVALID_CREDENTIALS: No token provided`. Always guard with `?? ''` so the error is fetch-time, not construction-time.
- **Insert not wrapped in array**: InsForge's PostgREST dialect requires `insert([{...}])`. Supabase was lenient. This is the most common silent failure when porting.
- **`service_role` bypass semantics**: functions assumed `service_role` → full-DB access. `API_KEY` (project_admin) is subject to RLS. Either (a) `migrate-database` added admin bypass policies (default), or (b) use an explicit raw-SQL call via `client.database.sql(...)` with the admin key.
- **Per-function env from Supabase project settings**: Supabase stored these in dashboard, not DB. User must re-enter each via `npx @insforge/cli secrets add`. Do NOT assume they carry over.
- **SQL-INSERT-only deploy is wrong**: inserting into `functions.definitions` with `status='active'` does NOT make the runtime serve the code. Always `npx @insforge/cli functions deploy`.
- **SSO/SAML callbacks**: functions like `sso-callback` that mint Supabase sessions via `supabase.auth.admin.createSession` cannot be auto-ported. Surface to user; rewrite requires understanding InsForge's current session API.

## Scope boundary

Covers: per-function source rewrite, secret additions, deploy, smoke test. Does NOT cover: shared utility modules (`supabase/functions/_shared/*` must be inlined or uploaded as separate files per function — flag to user), routing/CORS customization, per-function rate limits, custom domains for function URLs.
