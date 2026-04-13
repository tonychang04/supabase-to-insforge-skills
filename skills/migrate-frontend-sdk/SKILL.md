---
name: migrate-frontend-sdk
description: Use when rewriting a frontend codebase from @supabase/supabase-js to @insforge/sdk. Runs a grep-based inventory of call sites first, then rewrites imports, client init, auth flows, database queries, storage uploads, and function invocations. Flags patterns that don't auto-port (realtime channels, auth.admin session flows).
---

# Migrate Frontend SDK (@supabase/supabase-js → @insforge/sdk)

## When to invoke

- Orchestrator dispatched to this skill
- User has a frontend repo (Next.js, React, Vue, etc.) that imports `@supabase/supabase-js`
- Database + auth + storage migration is complete or in progress

## When NOT to invoke

- Backend-only repos (no `@supabase/supabase-js` usage)
- Repos using a non-JS Supabase SDK (Python/Dart/Flutter/etc.) — different mapping, not covered here

## Inputs required

```
Frontend repo path                 # directory with package.json importing @supabase/supabase-js
INSFORGE_BASE_URL                  # public API URL for the target project
INSFORGE_ANON_KEY                  # anonymous JWT (from Project Settings)
```

## Recommended (helpful but not required): link project via CLI for live inspection

While the rewrite itself needs no CLI, linking the target project makes debugging much faster (inspect tables via `npx @insforge/cli db query`, tail backend logs via `npx @insforge/cli logs postgREST.logs`, re-check metadata, etc.).

To link:
1. Open the InsForge dashboard for the target project.
2. Click **Connect** in the top-right — it shows a one-time login+link command.
3. Run it in the repo directory: it creates `.insforge/project.json` with the scoped credentials.

After linking, `npx @insforge/cli current` should print the project name. Add `.insforge/` to `.gitignore`.

## Diagnostic probe (inventory FIRST, before any edits)

```bash
cd <frontend-repo>

# All files importing supabase-js
grep -rlE "from ['\"]@supabase/supabase-js['\"]" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' .

# Call-site categories with counts
grep -rE "supabase\.(auth|from|storage|functions|channel|rpc)" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' . \
  | grep -oE "supabase\.[a-z]+\.[a-zA-Z]+|supabase\.[a-z]+\(" | sort | uniq -c | sort -rn

# Env var references
grep -rnE "NEXT_PUBLIC_SUPABASE|SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.env*' --include='*.mjs' .
```

Produce an inventory report for the user:
```
Files touching supabase-js: N
Call sites:
  supabase.auth.X:      N total (getUser: N, getSession: N, signInWithPassword: N, ...)
  supabase.from(...):   N
  supabase.storage.*:   N
  supabase.functions.*: N
  supabase.channel(...): N    ← manual rewrite required
  supabase.rpc(...):    N     ← verify each
Env vars: NEXT_PUBLIC_SUPABASE_URL (N refs), NEXT_PUBLIC_SUPABASE_ANON_KEY (N refs), ...
```

## Rewrite cheat sheet

### Imports + client init

```typescript
// BEFORE
import { createClient } from '@supabase/supabase-js';
import type { User, Session } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```

```typescript
// AFTER
import { createClient } from '@insforge/sdk';
import type { User, Session } from '@insforge/sdk';   // verify names: consult npm:@insforge/sdk@latest types

const client = createClient({
  baseUrl: process.env.NEXT_PUBLIC_INSFORGE_BASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY!,
});
```

```diff
// .env changes
- NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
- NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
+ NEXT_PUBLIC_INSFORGE_BASE_URL=https://<app-key>.<region>.insforge.app
+ NEXT_PUBLIC_INSFORGE_ANON_KEY=eyJhbGc...
# Server-only — only if you do admin ops from the frontend (discouraged):
- SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
+ INSFORGE_API_KEY=ik_...
```

### Auth

| Supabase-js | InsForge SDK |
|---|---|
| `supabase.auth.signUp({ email, password })` | `client.auth.signUp({ email, password })` |
| `supabase.auth.signInWithPassword({ email, password })` | `client.auth.signInWithPassword({ email, password })` |
| `supabase.auth.signOut()` | `client.auth.signOut()` |
| `supabase.auth.getUser()` | `client.auth.getCurrentUser()`  *(verify exact method name in target SDK version)* |
| `supabase.auth.getSession()` | `client.auth.getSession()` — verify return shape |
| `supabase.auth.onAuthStateChange(cb)` | `client.auth.onAuthStateChange(cb)` — verify name/signature |
| `supabase.auth.updateUser({ password })` | `client.auth.updateUser({ password })` |
| `supabase.auth.resetPasswordForEmail(email, {redirectTo})` | `client.auth.resetPasswordForEmail(email, {redirectTo})` |
| `supabase.auth.admin.*` (server/function context) | `client.auth.admin.*` — verify per method; some (e.g., `createSession`) don't port |

**Session storage differences:** Supabase stores tokens in localStorage by default. InsForge SDK storage behavior may differ (check SDK options). If app uses SSR and relies on cookie-based sessions (e.g., Next.js middleware reading Supabase cookies), the cookie format changes — update middleware (see "SSR/middleware" below).

### Database

| Supabase-js | InsForge SDK |
|---|---|
| `supabase.from('t').select('a,b,c')` | `client.database.from('t').select('a,b,c')` |
| `supabase.from('t').select('*, fk_col:fk_target(*)')` | `client.database.from('t').select('*, fk_col:fk_target(*)')` — identical PostgREST syntax |
| `supabase.from('t').insert({a: 1})` | `client.database.from('t').insert([{a: 1}])` — **array wrap required** |
| `supabase.from('t').update({a:1}).eq('id', x)` | `client.database.from('t').update({a:1}).eq('id', x)` |
| `supabase.from('t').delete().eq('id', x)` | `client.database.from('t').delete().eq('id', x)` |
| Filters: `.eq / .neq / .gt / .gte / .lt / .lte / .like / .ilike / .in / .is / .not / .or / .and` | Same — PostgREST standard |
| `.order('col', {ascending: false})` / `.limit(N)` / `.range(a,b)` | Same |
| `.single()` / `.maybeSingle()` | Same |
| `supabase.rpc('fn', {p: 1})` | `client.database.rpc('fn', {p: 1})` — verify with `npx @insforge/cli docs db-sdk` before bulk-rewriting |

### Storage

| Supabase-js | InsForge SDK |
|---|---|
| `supabase.storage.from(b).upload(path, file)` | `client.storage.from(b).upload(path, file)` |
| `supabase.storage.from(b).download(path)` | `client.storage.from(b).download(path)` |
| `supabase.storage.from(b).remove([path])` | `client.storage.from(b).remove([path])` |
| `supabase.storage.from(b).getPublicUrl(path).data.publicUrl` | `client.storage.from(b).getPublicUrl(path)` — verify return shape |
| `supabase.storage.from(b).createSignedUrl(path, expires)` | `client.storage.from(b).createSignedUrl(path, expires)` |

Hardcoded URL patterns in the frontend (if any) must also update:
```diff
- const url = `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}`;
+ const url = `${INSFORGE_BASE_URL}/api/storage/buckets/${bucket}/objects/${key}`;
```

### Functions

| Supabase-js | InsForge SDK |
|---|---|
| `supabase.functions.invoke('fn', { body })` | `client.functions.invoke('fn', { body })` |

If any hardcoded URLs exist:
```diff
- fetch(`${SUPABASE_URL}/functions/v1/${slug}`, {...})
+ fetch(`${INSFORGE_BASE_URL.replace('.insforge.app','.functions.insforge.app')}/${slug}`, {...})
+ // Better: use client.functions.invoke
```

### Realtime — **manual rewrite required**

```typescript
// BEFORE
supabase.channel('room-a')
  .on('broadcast', { event: 'msg' }, payload => { ... })
  .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, payload => { ... })
  .subscribe();
```

InsForge uses a pattern + webhook model — not a 1:1 port. Options:
1. Best: replace realtime with server-sent events from a deployed InsForge function that polls the DB.
2. If realtime channels exist on InsForge with compatible SDK methods, verify via `npx @insforge/cli docs real-time`.
3. Flag the user: every `supabase.channel(...)` usage needs human review.

### SSR / Next.js middleware

Supabase provides `@supabase/ssr` for cookie-based session handling in Next middleware. If the app uses it:
- Remove `@supabase/ssr`
- Rebuild middleware against `@insforge/sdk` cookie semantics (or switch to client-only auth via localStorage if cookie-SSR isn't critical)
- This is a focused rewrite — don't mechanically translate.

### Types

```diff
- import type { User, Session } from '@supabase/supabase-js';
+ import type { User, Session } from '@insforge/sdk';   // verify type names in installed SDK version
```

Be aware: `User.user_metadata` (Supabase) was backed by `raw_user_meta_data`. Under migrate-auth's mapping, that went to InsForge's `metadata` (jsonb). Frontend code that does `user.user_metadata.X` may need to read `user.metadata.X` depending on the SDK's type mapping. Run app + spot-check one signed-in path.

## Procedure

### 1. Install SDK, remove old

```bash
cd <frontend-repo>
npm remove @supabase/supabase-js @supabase/ssr @supabase/auth-helpers-nextjs 2>/dev/null
npm install @insforge/sdk@latest
```

### 2. Update `.env.local` / `.env`

Replace `NEXT_PUBLIC_SUPABASE_*` → `NEXT_PUBLIC_INSFORGE_*` (see cheat sheet above). Keep a `.env.backup` of the old values during cutover.

### 3. Replace SDK initialization file

Typically `lib/supabase.ts` / `lib/supabase/client.ts`:

```typescript
// lib/insforge.ts (new)
import { createClient } from '@insforge/sdk';

export const client = createClient({
  baseUrl: process.env.NEXT_PUBLIC_INSFORGE_BASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY!,
});
```

### 4. Mechanical rewrites across call sites

For each category, use find-replace (sed or IDE), then manually review diffs:

```bash
# Shift namespace: supabase.from( → client.database.from(
grep -rl 'supabase\.from(' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' . | \
  xargs sed -i.bak 's/supabase\.from(/client.database.from(/g'

# Array-wrap insert values (tricky — review each):
# Pattern: .insert({...})  →  .insert([{...}])
# Use IDE multi-cursor or manually inspect `.insert(` hits.

# supabase.auth.* stays mostly the same → rename the variable:
grep -rl 'supabase\.auth\.' --include='*.ts' --include='*.tsx' . | \
  xargs sed -i.bak 's/supabase\.auth\./client.auth./g'

# supabase.storage.* stays mostly the same:
grep -rl 'supabase\.storage\.' --include='*.ts' --include='*.tsx' . | \
  xargs sed -i.bak 's/supabase\.storage\./client.storage./g'

# Rename the import
grep -rl "from '@supabase/supabase-js'" --include='*.ts' --include='*.tsx' . | \
  xargs sed -i.bak "s|from '@supabase/supabase-js'|from '@insforge/sdk'|g"

# Remove .bak files after review
find . -name '*.bak' -delete
```

### 5. Manually review:

- Every `.insert(` — confirm array wrapping
- Every `supabase.rpc` (now `client.database.rpc`) — verify each arg shape
- Every `onAuthStateChange` usage — method name/signature may differ
- Every `supabase.channel(...)` — manual rewrite
- Every `getUser()` usage — may be `getCurrentUser()` in InsForge SDK
- Every `user.user_metadata.X` → `user.metadata.X` if SDK types exposed the renamed field
- SSR middleware (`lib/supabase/middleware.ts`, `app/middleware.ts`) — rebuild; don't mechanically translate
- Server admin client (`lib/supabase/admin.ts`) — change to InsForge SDK with `API_KEY` (server-only)

### 6. Type-check, build, run

```bash
npx tsc --noEmit
npm run build
npm run dev
```

Walk through core flows by hand:
- [ ] Sign up a new user
- [ ] Sign in existing (migrated) user with original password
- [ ] List a table (RLS applied — should see only own rows)
- [ ] Insert a row
- [ ] Upload a file
- [ ] Invoke a deployed function

## Verification

```bash
cd <frontend-repo>
# After rewrite, these should ALL return 0 lines:
grep -rnE "from '@supabase/supabase-js'" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' .
grep -rnE "NEXT_PUBLIC_SUPABASE|SUPABASE_ANON_KEY" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.env*' .
grep -rnE "supabase\.(auth|from|storage|functions|channel|rpc)" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' .
# Ports should now be:
grep -rnE "from '@insforge/sdk'" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' . | wc -l     # non-zero
grep -rnE "client\.(auth|database|storage|functions)" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' . | wc -l  # non-zero
```

## Common pitfalls

- **`.insert({...})` without array wrap**: compiles, calls out, 400 at runtime. Review every `.insert(` hit manually — sed can't decide array-wrap on multi-line payloads.
- **`getUser()` vs `getCurrentUser()`**: method name change. Compile errors catch this; but dynamic code paths (`supabase['auth']['getUser']()`) won't.
- **SSR cookies**: `@supabase/ssr` + Next middleware → don't mechanically rewrite. Consider dropping SSR session if non-critical and re-auth on client.
- **`user.user_metadata` vs `user.metadata`**: renames silently pass through `any` types. Run the app; smoke-test profile read.
- **`supabase.auth.admin.*` on the frontend**: if the app ever instantiated a service-role client on the client (dangerous but happens), route that to a dedicated InsForge function and call it via `client.functions.invoke`.
- **Realtime not caught by sed**: `supabase.channel()` / `.subscribe()` / presence / broadcast usages ARE the migration. Manual rewrite; reference `npx @insforge/cli docs real-time`.
- **Hardcoded storage URLs**: a sed swap `supabase.co/storage/v1/object/public` → `<app-key>.insforge.app/api/storage/buckets` ... `/objects/...` is easy to miss. Grep explicitly: `grep -rE 'supabase\.co/storage' .`.
- **Forgotten admin client in `lib/supabase/admin.ts`**: server-side admin operations need `INSFORGE_API_KEY` (not `ANON_KEY`). Keep server/client separation.
- **Dependent packages**: `@supabase/auth-ui-react`, `@supabase/auth-helpers-*`, `@supabase/ssr` — all Supabase-specific. Remove. No direct InsForge equivalent for auth-ui; build your own form against `client.auth.signIn*` or use a generic auth UI library.
- **Type imports from removed package**: after uninstalling `@supabase/supabase-js`, `import type { User } from '@supabase/supabase-js'` errors. Update to `@insforge/sdk`; if the type names differ, create local type aliases or import from the InsForge package's types.

## Scope boundary

Covers: SDK swap across imports, client init, auth/database/storage/functions call-site rewrites, env variable rename, dependency swap in package.json. Does NOT cover: rebuilding SSR/cookie session infrastructure (requires per-app design), migrating auth UI components, realtime channel rearchitecture, custom RPC shape verification (user must test each).
