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

## Full SDK API gap table — what needs manual rewrite (verified 2026-04-13)

Every item in this table was hit during a real green-build migration of stet (30 files, 51 call sites). These are NOT candidates for sed — each needs either manual replacement or a decision.

### Auth surface

| Supabase pattern | Count hit in stet | InsForge replacement | Effort |
|---|---|---|---|
| `auth.getSession()` → `data.session.access_token` | 4 | `getCurrentUser()` returns `{user}`, no session object. For raw token access, read `localStorage.getItem('insforge-auth-token')` and parse `.accessToken` | per-site judgment |
| `auth.getUser()` | 15+ | `auth.getCurrentUser()` | sed OK |
| `auth.onAuthStateChange(cb)` | 1 | No event subscription API. Pattern used: `visibilitychange` listener → `getCurrentUser()` + explicit refresh in sign-in/out handlers | manual |
| `auth.updateUser({ password })` | 1 | `sendResetPasswordEmail({email})` → email → `exchangeResetPasswordToken({otp, newPassword})`. Two-step UX now, unavoidable | manual + UX change |
| `auth.resetPasswordForEmail(email, {redirectTo})` | 2 | `sendResetPasswordEmail({email, redirectTo})` | manual (method rename + arg shape) |
| `auth.signUp({options: {data}})` | 1 | `signUp({name})` + separate `setProfile(extras)` call after | manual |
| `auth.admin.*` | (varies) | No `admin` namespace. Admin client + direct `.database.from('auth.users')` | per-method manual |

### Type name differences

| Supabase type | InsForge type | Where it appears |
|---|---|---|
| `import type { User } from '@supabase/supabase-js'` | `import type { UserSchema } from '@insforge/sdk'` | auth providers, navbars, anywhere typed as User |
| `import type { Session } from '@supabase/supabase-js'` | `import type { AuthSession } from '@insforge/sdk'` | auth providers |
| `user.email_confirmed_at` / `user.confirmed_at` | `user.emailVerified` (boolean) | verification gates |
| `user.created_at`, `user.updated_at` | `user.createdAt`, `user.updatedAt` (camelCase) | plan hooks, audit logs |
| `user.user_metadata` | `user.metadata` | profile reads, cast may be needed |
| `user.app_metadata` | `user.profile` or `user.metadata` (nesting differs) | role checks |
| `session.access_token`, `refresh_token`, `expires_at`, `expires_in`, `token_type` | `.accessToken`, `.refreshToken`, `.expiresAt`, `.expiresIn`, `.tokenType` (camelCase) | custom bearer-header builders |

Recommended one-shot sed pass for camelCase (run AFTER import swaps):

```bash
grep -rlE "\.(access_token|refresh_token|expires_at|expires_in|token_type|user_metadata|app_metadata)\b" --include='*.ts' --include='*.tsx' . \
  | grep -v node_modules | grep -v 'lib/supabase/' | while IFS= read -r f; do
    sed -i.bak -E '
      s/\.access_token\b/.accessToken/g
      s/\.refresh_token\b/.refreshToken/g
      s/\.expires_at\b/.expiresAt/g
      s/\.expires_in\b/.expiresIn/g
      s/\.token_type\b/.tokenType/g
      s/\.user_metadata\b/.metadata/g
      s/\.app_metadata\b/.profile/g
    ' "$f"
  done
find . -name '*.bak' -not -path './node_modules/*' -delete
```

**Warning:** the above blindly renames `.expires_at` on domain objects too (e.g., `invite.expires_at`, `policy.expires_at`). Review the diff — domain fields should keep snake_case. A safer version scopes to known session/user receivers (use ts-morph instead).

## AST rewrite script (copy-paste)

The `.from()` and `.insert()` rewrites cannot be done with sed alone. Use this ts-morph script (verified — 92 `.from()` + 19 `.insert()` rewrites on stet):

```typescript
// scripts/migrate-ast.ts
import { Project, SyntaxKind, Node } from "ts-morph";
const CLIENT_NAMES = new Set(["supabase", "client", "insforge", "adminClient"]);
const p = new Project({ tsConfigFilePath: "tsconfig.json" });
let fromRewrites = 0, insertRewrites = 0;

function rootIdentifier(n: Node): string | null {
  let cur: Node | undefined = n;
  while (cur) {
    if (cur.getKind() === SyntaxKind.Identifier) return cur.getText();
    if (cur.getKind() === SyntaxKind.PropertyAccessExpression) {
      cur = cur.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getExpression();
    } else if (cur.getKind() === SyntaxKind.CallExpression) {
      cur = cur.asKindOrThrow(SyntaxKind.CallExpression).getExpression();
    } else if (cur.getKind() === SyntaxKind.AwaitExpression) {
      cur = cur.asKindOrThrow(SyntaxKind.AwaitExpression).getExpression();
    } else return null;
  }
  return null;
}

for (const sf of p.getSourceFiles()) {
  const path = sf.getFilePath();
  if (path.includes("/node_modules/") || path.includes("/lib/supabase/")
      || path.includes("/lib/insforge/") || path.includes("/supabase/functions/")
      || path.match(/\.test\.(ts|tsx)$/) || path.includes("/__tests__/")) continue;
  let changed = false;

  // Rewrite .from → .database.from on known client chains
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const pa = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pa.getName() !== "from") return;
    const receiver = pa.getExpression();
    if (/^[A-Z]/.test(receiver.getText())) return;  // skip Array.from etc
    const root = rootIdentifier(receiver);
    if (!root || !CLIENT_NAMES.has(root)) return;
    if (receiver.getText().includes(".database")) return;
    pa.replaceWithText(`${receiver.getText()}.database.from`);
    fromRewrites++; changed = true;
  });

  // Wrap .insert(obj) → .insert([obj]) if arg is not already an array/spread
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const ce = node.asKindOrThrow(SyntaxKind.CallExpression);
    const expr = ce.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const pa = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pa.getName() !== "insert") return;
    const root = rootIdentifier(pa.getExpression());
    if (!root || !CLIENT_NAMES.has(root)) return;
    const args = ce.getArguments();
    if (args.length === 0) return;
    const first = args[0];
    if (first.getKind() === SyntaxKind.ArrayLiteralExpression) return;
    if (first.getText().trim().startsWith("...")) return;
    first.replaceWithText(`[${first.getText()}]`);
    insertRewrites++; changed = true;
  });

  if (changed) sf.saveSync();
}
console.log(`Rewrote ${fromRewrites} .from() + ${insertRewrites} .insert() calls`);
```

Run: `npm i -D ts-morph && npx tsx scripts/migrate-ast.ts`.

## Hard lessons from a real trial (stet repo, 2026-04-13)

These are **failures** encountered when attempting a mechanical sed-based migration. Encode them as non-negotiable rules.

### 1. sed cannot rewrite multi-line call chains

Common Next.js pattern splits receiver and method across lines:

```typescript
const { data, error } = await supabase
    .from("vdr_snapshots")           // ← .from on a different line from supabase
    .select("id, label");
```

`sed -E 's/\bsupabase\.from\(/supabase.database.from(/g'` does NOT match this — the newline between `supabase` and `.from` is on the literal input, not the regex. Result: you think you've rewritten the codebase, `npm run build` fails on dozens of these.

**Rule:** for rewrites more ambitious than a single token, use an AST transformer — `ts-morph`, `jscodeshift`, or `@ast-grep/cli`. Not sed, not perl, not find-replace in an IDE (which also struggles with method-receiver breaks across lines).

```bash
# Minimal ts-morph script sketch
npx ts-node -e '
  import { Project } from "ts-morph";
  const p = new Project({ tsConfigFilePath: "tsconfig.json" });
  p.getSourceFiles().forEach(sf => {
    sf.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(call => {
      const expr = call.getExpression();
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const prop = expr as PropertyAccessExpression;
        if (prop.getName() === "from" && isClientReceiver(prop.getExpression())) {
          prop.replaceWithText(prop.getExpression().getText() + ".database.from");
        }
      }
    });
  });
  p.save();
'
```

### 2. `.insert({...})` → `.insert([{...}])` needs AST, not regex

Regex can't reliably decide whether an `.insert(` argument is already an array, a spread, a variable, or an inline object. Don't try. Use an AST walk that checks the first argument's kind.

### 3. The build IS the test

Do NOT claim the migration is done until `npm run build` exits 0. Intermediate states ("imports swapped, call sites rewritten, compile fails") are migration-in-progress, not migration-done. The skill's verification step `npx tsc --noEmit && npm run build` must succeed; all other signals are secondary.

### 4a. Actual InsForge SDK surface — verified 2026-04-13

Read from `node_modules/@insforge/sdk/dist/index.d.ts`. Methods that exist on `client.auth`:

```
signUp, signInWithPassword, signOut, signInWithOAuth, exchangeOAuthCode,
signInWithIdToken, refreshSession, getCurrentUser, getProfile, setProfile,
resendVerificationEmail, verifyEmail, exchangeResetPasswordToken, resetPassword
```

Patterns that exist in Supabase but NOT in InsForge (require call-site rebuild, not replacement):

| Supabase | InsForge status | Workaround |
|---|---|---|
| `auth.onAuthStateChange(cb)` | **absent** | poll `getCurrentUser()` on mount + focus, or subscribe to your own store after explicit sign-in/out |
| `auth.admin.createUser(...)` | **no `admin` namespace** | admin client with `API_KEY`, direct DB INSERT into `auth.users` via `.database.from('auth.users').insert([{...}])` |
| `auth.admin.getUserByEmail(...)` | **no `admin` namespace** | admin client, `.database.from('auth.users').select().eq('email', x).maybeSingle()` |
| `auth.admin.deleteUser(x)` | **no `admin` namespace** | admin client, `.database.from('auth.users').delete().eq('id', x)` |
| `auth.admin.createSession(...)` | **no equivalent** | not portable in one call; SSO flow needs rebuild |
| `auth.updateUser({ password: ... })` | **absent** | `resetPassword()` + user clicks link + `exchangeResetPasswordToken()` |
| `auth.getSession()` | **absent** | use `getCurrentUser()` — returns `{ user: ... }` wrapper |

**Critical:** do NOT sed-replace `onAuthStateChange` with `onSessionChange` — `onSessionChange` does not exist either. The replacement compiles but fails at runtime with "property does not exist".

### 4b. Inspect the actual SDK types before rewriting

Published docs, CLI `docs` command, and community examples can lag the installed SDK version. Before bulk rewrites:

```bash
# Find the source of truth for method names + signatures
find node_modules/@insforge/sdk -name "*.d.ts" | head -5
grep -rE "auth\.(getCurrentUser|getUser|onAuthStateChange|onSessionChange)" node_modules/@insforge/sdk/dist/ | head
grep -rE "^export.*createClient|^declare.*createClient" node_modules/@insforge/sdk/dist/ | head
```

Especially check: exact `createClient` return type, namespacing (`.database.from` vs `.from`), method renames (`getUser` vs `getCurrentUser`), array-wrap requirements on `insert`.

### 5. SSR cookie names are not documented; inspect runtime

The InsForge SDK writes httpOnly refresh cookies, but the exact cookie name (`insforge-refresh-token`? `sb-auth-token`-style? something project-scoped?) must be verified by actually signing in once and watching `Set-Cookie` headers:

```bash
# During the migration, log in manually via the migrated frontend, then:
curl -sI -X POST "$INSFORGE_BASE_URL/api/auth/sessions" \
  -H "Content-Type: application/json" \
  -d '{"email":"<test>","password":"<test>"}' 2>&1 | grep -i "set-cookie"
```

Do NOT guess at the cookie name prefix; hardcoding `insforge-*refresh*` in middleware will silently kick every logged-in user out if the real name is different.

### 6. Admin API methods are NOT 1:1 with Supabase

`supabase.auth.admin.createUser`, `generateLink`, `getUserByEmail`, `deleteUser` — these map to different InsForge shapes (if at all). Grep every `auth.admin.` call, verify each against the SDK types, and surface any without direct equivalents for manual redesign.

### 7. SSR via `@supabase/ssr` has no direct replacement

`@supabase/ssr` provided `createBrowserClient` / `createServerClient` with explicit cookie getAll/setAll hooks for Next.js App Router. InsForge SDK does not ship an equivalent. Options:

- **Option A (simplest):** drop SSR auth entirely. All auth reads happen client-side via `createClient().auth.getCurrentUser()`. Server components that need the user fall back to a client component shell. Removes a lot of complexity at the cost of a render-flicker on auth pages.
- **Option B:** write a thin SSR wrapper (~30 LOC): parse the refresh cookie out of the request, call `client.auth.refreshSession({ refreshToken })` server-side, return the client for downstream queries. Fragile — depends on cookie-name stability.
- **Option C:** move server-side DB access to the admin client (`INSFORGE_API_KEY`) and do auth checks via your own session table. Most invasive but most portable.

Don't attempt Option B as a first pass unless you've verified the cookie name (see #5).

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
