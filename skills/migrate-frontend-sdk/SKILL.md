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

Framework-specific env prefixes (see also the framework-detection table at the bottom): Next.js uses `NEXT_PUBLIC_*`/`process.env.*`; Vite uses `VITE_*`/`import.meta.env.*`; Nuxt uses `NUXT_PUBLIC_*` (public) / `NUXT_*` (private) accessed via `useRuntimeConfig().public.*` / `useRuntimeConfig().*`.

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

### 8a. Rename local variable `supabase` → `insforge` for readability

After the SDK swap, local variables still named `supabase` become misleading:

```typescript
// Confusing — is this Supabase or InsForge now?
const supabase = createClient();
const { data } = await supabase.database.from("t").select("*");
```

Use word-boundary regex to rename the identifier. **Important:** macOS BSD `sed` does NOT support `\b` — use Perl:

```bash
grep -rlE "const +supabase +=" --include='*.ts' --include='*.tsx' . \
  | grep -v node_modules | grep -v lib/insforge | grep -v __tests__ \
  | grep -v "supabase/functions" \
  | while IFS= read -r f; do
      perl -i -pe 's/\bsupabase\b/insforge/g' "$f"
    done
```

This keeps intentional `supabase` mentions in:
- `lib/security/redaction.ts` patterns that still redact legacy tokens
- Comments referencing the migration origin

Verify with a grep that excludes those categories and confirm build still passes before committing.

### 8b. Env var names — beyond the provider wrapper

`process.env.NEXT_PUBLIC_SUPABASE_*` references are often **outside** the `lib/supabase/client.ts` file that you rewrote. Grep broadly before declaring the migration done:

```bash
grep -rnE "NEXT_PUBLIC_SUPABASE_|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_JWT_SECRET|SUPABASE_URL(?!.*pooler)" \
  --include='*.ts' --include='*.tsx' . | grep -v node_modules | grep -v __tests__
```

Common hits not caught by method-call sed:
- **Auth provider "is configured?" guards** — code reads env vars directly to decide whether to enable auth features (stet: `lib/auth.tsx:46-47`). If you miss these, runtime error is `"Authentication not configured"` even though the build compiles clean.
- **Zod-validated env loaders** — a `lib/config/env.ts` or similar that types and validates the env, often with the old names as keys. Rename both the interface fields AND the getter fallbacks.
- **`.env.example`, `.env.local`** — rename values you seed users with.
- **CI/CD pipeline env** — dashboards, deployment configs often still have `NEXT_PUBLIC_SUPABASE_*` keys. Update them too; missed ones will manifest as runtime "Authentication not configured" in prod.

Rename map (stet trial, verified):

| Old | New |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `NEXT_PUBLIC_INSFORGE_BASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `NEXT_PUBLIC_INSFORGE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | `INSFORGE_API_KEY` |
| `SUPABASE_JWT_SECRET` | `INSFORGE_JWT_SECRET` (if still needed — InsForge sessions are JWT, secret usage differs) |

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

### 5. SSR cookie pattern — canonical, from official `insforge-skills`

**CRITICAL CORRECTION (2026-04-15).** Earlier versions of this skill described SSR as reading a single SDK-set cookie `insforge_refresh_token` and calling `refreshSession`. That works but misses the official pattern, which is materially different and required for `client.database.*` / `client.storage.*` calls to execute **with the signed-in user's identity** (so RLS applies correctly).

**Canonical pattern (from https://github.com/InsForge/insforge-skills — `skills/insforge/auth/ssr-integration.md`):**

1. **Server client must opt into server mode:**
   ```typescript
   createClient({
     baseUrl,
     anonKey,
     isServerMode: true,              // disables browser auto-detect, cookies, etc.
     edgeFunctionToken: accessToken,  // authenticates outgoing requests as this user
   })
   ```
   Missing `edgeFunctionToken` → every `.database.from(...)` call hits RLS as anon even when a valid access token exists in a cookie.

2. **Two cookies, APP-managed (not SDK-managed):**

   | Cookie | TTL | What for |
   |---|---|---|
   | `insforge_access_token` | 15 min | sent as bearer on every authenticated DB/storage/function call |
   | `insforge_refresh_token` | 7 days | used by middleware to mint new access tokens |
   | `insforge_code_verifier` | 10 min | PKCE verifier, written before OAuth redirect, read+deleted on callback |

   **All three are httpOnly, Secure, SameSite=lax, Path=/.** The app's server actions and callback route explicitly `cookieStore.set(...)` them — the SDK in `isServerMode: true` does NOT touch browser cookies.

3. **Sign-in server action must call `setAuthCookies(data.accessToken, data.refreshToken)` AFTER `signInWithPassword`.** Omit this and the user signs in but every subsequent server render thinks they're anonymous.

4. **OAuth flow requires `skipBrowserRedirect: true` + manual code exchange.** The browser SDK auto-detects `insforge_code` in the URL; `isServerMode: true` disables this. Flow:
   - Server action: `signInWithOAuth({ provider, redirectTo, skipBrowserRedirect: true })` → returns `{ url, codeVerifier }`
   - Write `codeVerifier` to httpOnly cookie
   - Redirect browser to `url`
   - Provider redirects back to your `redirectTo` with `?insforge_code=<code>`
   - Callback route reads cookie, calls `exchangeOAuthCode(code, codeVerifier)`, sets auth cookies, deletes verifier cookie
   - **`redirectTo` must be your app URL** (`NEXT_PUBLIC_SITE_URL`), NOT your InsForge URL. The backend appends `?insforge_code=...` and redirects there; if it points at InsForge you get `Cannot GET /auth/callback`.

5. **Middleware pattern — refresh proactively:**
   - Read both cookies from the request
   - If access token missing but refresh present → call `refreshSession({refreshToken})`, write both cookies on the response
   - Use access-token presence as the "authenticated" signal for route guards
   - Don't call `.getCurrentUser()` in middleware on every request (unnecessary round-trip)

6. **The OAuth query param name is `insforge_code`**, not `code`. Supabase used `?code=`. Callback handlers need to read either:
   ```typescript
   const code = searchParams.get("insforge_code") ?? searchParams.get("code");
   ```

7. **`signUp` return value:** if email verification is disabled, `data.accessToken` is populated — treat it exactly like sign-in and set cookies. If verification is required, `accessToken: null` and you get `requireEmailVerification: true` — show "check your email" and don't set cookies yet.

8. **`exchangeCodeForSession` is renamed** to `exchangeOAuthCode(code, codeVerifier?)`. Always pass the codeVerifier from your stored cookie.

**Minimal cookie-helper module (drop-in):**

```typescript
// lib/insforge/cookies.ts
import { cookies } from "next/headers"

export const ACCESS_COOKIE = "insforge_access_token"
export const REFRESH_COOKIE = "insforge_refresh_token"
export const CODE_VERIFIER_COOKIE = "insforge_code_verifier"

const BASE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
}

export async function setAuthCookies(accessToken: string, refreshToken: string) {
  const s = await cookies()
  s.set(ACCESS_COOKIE, accessToken, { ...BASE, maxAge: 60 * 15 })
  s.set(REFRESH_COOKIE, refreshToken, { ...BASE, maxAge: 60 * 60 * 24 * 7 })
}
export async function clearAuthCookies() {
  const s = await cookies()
  s.delete(ACCESS_COOKIE); s.delete(REFRESH_COOKIE); s.delete(CODE_VERIFIER_COOKIE)
}
export async function setCodeVerifierCookie(v: string) {
  (await cookies()).set(CODE_VERIFIER_COOKIE, v, { ...BASE, maxAge: 60 * 10 })
}
export async function readAccessToken() {
  return (await cookies()).get(ACCESS_COOKIE)?.value
}
export async function readRefreshToken() {
  return (await cookies()).get(REFRESH_COOKIE)?.value
}
export async function readCodeVerifier() {
  return (await cookies()).get(CODE_VERIFIER_COOKIE)?.value
}
```

**Server client using it:**

```typescript
// lib/insforge/server.ts
import { createClient as createInsforgeClient } from "@insforge/sdk"
import { readAccessToken } from "./cookies"

export async function createClient() {
  const accessToken = await readAccessToken()
  return createInsforgeClient({
    baseUrl: process.env.NEXT_PUBLIC_INSFORGE_BASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY!,
    isServerMode: true,
    edgeFunctionToken: accessToken,
  } as Parameters<typeof createInsforgeClient>[0])
}
```

### 5b. Legacy guess about cookie name (superseded — kept for history)

Actual observed cookie after live signup + email_verified=true flag + login:

```
Set-Cookie: insforge_refresh_token=<JWT>;
  Max-Age=604800;
  Path=/api/auth;
  Expires=<7 days>;
  HttpOnly; Secure; SameSite=None
```

Use **exact-match** on cookie name — do NOT prefix-match. Prefixes like `insforge-` (with dash) or `insforge_` (with underscore) can accidentally catch unrelated cookies if InsForge adds new ones.

```typescript
// lib/insforge/server.ts
const refreshCookie = cookieStore
    .getAll()
    .find((c) => c.name === "insforge_refresh_token");
```

**Reproducing the probe** (any future InsForge version might change this — re-verify on upgrade):

```bash
API_URL="https://<app-key>.<region>.insforge.app"
ANON="<anon-JWT>"
ADMIN_KEY="ik_..."

TEST="probe-$(date +%s)@test.local"
# 1. signup
curl -sS -X POST "$API_URL/api/auth/users" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST\",\"password\":\"TestPassword123!\"}"
# 2. mark email_verified=true via direct SQL (bypasses email verification)
psql "$INSFORGE_DB_URL" -c "UPDATE auth.users SET email_verified=true WHERE email='$TEST';"
# 3. login → Set-Cookie header reveals the exact name
curl -sD /dev/stderr -X POST "$API_URL/api/auth/sessions" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST\",\"password\":\"TestPassword123!\"}" 2>&1 \
  | grep -i "^set-cookie:"
# 4. cleanup
psql "$INSFORGE_DB_URL" -c "DELETE FROM auth.users WHERE email='$TEST';"
```

Auth API endpoints mined from `node_modules/@insforge/sdk/dist/index.js`:

```
POST /api/auth/users                          signup
POST /api/auth/sessions                       login  (sets insforge_refresh_token cookie)
POST /api/auth/refresh                        refresh
POST /api/auth/logout                         signout
GET  /api/auth/sessions/current               current session
GET  /api/auth/profiles/current               current profile
POST /api/auth/email/send-verification        resend verify email
POST /api/auth/email/verify                   confirm verify code
POST /api/auth/email/send-reset-password      send reset email
POST /api/auth/email/exchange-reset-password-token  exchange code
POST /api/auth/email/reset-password           apply new password with otp
POST /api/auth/oauth/...                      OAuth
POST /api/auth/id-token                       Google id_token flow
```

### 5b. Legacy notes on cookie-guessing (now solved)

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

## Hard lessons from the rayaboy-apply-hub trial (Vite SPA, 2026-04-23)

Full migration of a Vite + React 18 SPA (40 `.from()`, 3 storage, 3 functions.invoke, 11 auth sites, 2 `supabase.channel()` — which the first grep missed). Build green + 5/5 Playwright smokes passed. These are the *new* learnings beyond the stet (Next.js) trial.

### A. Inventory grep must include multi-line method chains

`grep -E "supabase\.(auth|from|storage|functions|channel|rpc)"` **misses** chained calls split across lines:

```tsx
const channel = supabase
  .channel("dashboard-jobs")
```

The single-line grep found 0 `channel` hits → they blew up at typecheck time much later. Fix: also grep chain continuations.

```bash
# Multi-line chain catcher (run AFTER the single-line inventory):
grep -rnE "^\s*\.(channel|from|rpc|storage|functions|auth)\(" --include='*.ts' --include='*.tsx' src | head -30
```

Add this to the skill's diagnostic probe unconditionally — realtime especially loves to hide here, and the default Supabase codegen pattern splits receiver and method on its own line.

### B. SDK surface (verified from installed `@insforge/sdk@latest` 2026-04-23)

Re-verify on upgrade — the schema can and does evolve.

**`createClient` config** (browser):
```ts
createClient({ baseUrl: string; anonKey: string; isServerMode?: boolean; edgeFunctionToken?: string })
```

**Auth methods present** (+ their installed shapes):
- `signUp(CreateUserRequest)` — **`CreateUserRequest = { email, password, name?, redirectTo?, autoConfirm? }`** (the Zod schema does include `name` and `redirectTo` as optional — last skill revision incorrectly said signup was email+password only and required a separate `setProfile()` call. You can pass `name` directly.)
- `signInWithPassword({ email, password })` — returns `{data: {user, accessToken, refreshToken?, csrfToken?}, error}`
- `signOut()` — returns `{error}`
- `getCurrentUser()` — returns `{data: {user: UserSchema | null}, error}` where `UserSchema = {id, email, emailVerified, providers?, createdAt, updatedAt, profile, metadata}` (all camelCase)
- `sendResetPasswordEmail({ email, redirectTo? })`
- `exchangeResetPasswordToken({ email, code })` → `{data: {token, ...}, error}` — the returned **token** is what you pass as `otp` to `resetPassword()`, NOT the raw 6-digit code
- `resetPassword({ newPassword, otp })` — `otp` = token from exchange step OR token from magic-link `?token=` query param
- `setProfile(Record<string, unknown>)` — jsonb passthrough — extra fields (e.g. `first_name`, `last_name`) are preserved alongside canonical `name`/`avatar_url`
- `resendVerificationEmail`, `verifyEmail`, `refreshSession`, `signInWithOAuth`, `exchangeOAuthCode`, `signInWithIdToken`, `getProfile`

**Auth methods absent** — the call site must be *rebuilt*, not renamed:
- `onAuthStateChange` — poll `getCurrentUser()` on mount + `visibilitychange`; expose a `refreshUser()` in context so sign-in/out handlers can force-sync.
- `getSession()` — there is no session object. Use `getCurrentUser()` for user identity; access tokens live in httpOnly cookies in browser mode.
- `updateUser({password})` — password changes go through the reset-password flow.
- `auth.admin.*` — no admin namespace on the client.

### C. Reset-password flow — two shapes, one page

InsForge emails can deliver either a 6-digit code *or* a magic link. When the link is clicked, the backend pre-exchanges it and sends the user to `redirectTo?token=<server-minted-token>&insforge_status=ready&insforge_type=reset_password`.

Your reset page should handle both:
```tsx
const urlToken = params.get("token");
const linkFlow = Boolean(urlToken && params.get("insforge_status") === "ready");
// ...
let token = urlToken;
if (!token) {
  const { data, error } = await insforge.auth.exchangeResetPasswordToken({ email, code });
  if (error) return setError(error.message);
  token = data.token;
}
await insforge.auth.resetPassword({ newPassword, otp: token });
```

Common mistake: calling `resetPassword({otp: code})` with the raw 6-digit code works for some backends but fails on modern InsForge — the exchange step is mandatory.

### D. Storage — two subtle API shape changes from Supabase AND from older skill revisions

| Op | Supabase | InsForge SDK (installed) |
|---|---|---|
| `remove` | `remove([path])` — **array** | `remove(path)` — **string** (earlier skill table wrongly showed array) |
| `getPublicUrl` | `{data: {publicUrl}}` | returns the **string directly**: `const url = bucket.getPublicUrl(key)` |
| `createSignedUrl(path, expires)` | present | **absent**. Two workable substitutes below. |

**Private-bucket preview without `createSignedUrl`:**

The SDK's `download(key)` returns a Blob over an authenticated request. Wrap it for caller compatibility:

```ts
const getSignedUrl = async (filePath: string) => {
  const { data: blob, error } = await insforge.storage.from("documents").download(filePath);
  if (error || !blob) return null;
  return URL.createObjectURL(blob);   // caller MUST revokeObjectURL on unmount
};
```

At the HTTP layer, `GET /api/storage/buckets/<bucket>/objects/<urlEncodedKey>` with a valid bearer returns **`302` to a CloudFront pre-signed URL** (`cdn.insforge.dev/...?Expires=...&Signature=...`). Browser `fetch()` follows the redirect and you get the blob; you cannot read the `Location` header from the browser due to Fetch-spec opaque-redirect rules, so the HTTP trick is server-side only. Stick with the SDK `download()` path for client code.

### E. Realtime — architectural shift, not a method rename

This is the most common source of "it compiles, it silently doesn't work." Supabase and InsForge ship realtime but implement it in opposite ways:

| | Supabase | InsForge |
|---|---|---|
| Event source | WAL tail (logical replication) — zero per-table setup | Explicit `realtime.publish(channel, event, payload)` calls — one trigger per table |
| Default for a new table | `postgres_changes` events flow immediately | Nothing flows until you register a channel pattern + attach a trigger |
| Filter mechanism | RLS on the source table, evaluated per subscriber on every change | RLS on `realtime.channels` (what a subscriber is allowed to *receive*), evaluated once on subscribe |

A pure-frontend swap from `supabase.channel("x").on("postgres_changes", ...)` to `insforge.realtime.subscribe("x").on("UPDATE", ...)` compiles fine but sits dark — the WS connects, `subscribe()` returns `{ok: false, code: "UNAUTHORIZED", message: "Not authorized to subscribe to this channel"}` because no pattern matches "x" in `realtime.channels`. No events ever land.

The full fix is frontend + backend. Use this template for each Supabase `postgres_changes` subscription in the app.

#### Backend migration template (one per table that needs realtime)

```sql
-- 1. Register channel patterns subscribers can match.
INSERT INTO realtime.channels (pattern, description, enabled) VALUES
  ('row:<table>:%', 'Per-row <table> updates',        true),
  ('list:<table>:%', 'Per-user <table> list updates', true)
ON CONFLICT (pattern) DO UPDATE SET enabled = EXCLUDED.enabled;

-- 2. RLS on realtime tables. Default is off (any authenticated user can
--    subscribe to anything that matches a pattern). Always enable it for
--    multi-user apps.
ALTER TABLE realtime.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

-- 3. Subscribe policies using realtime.channel_name() — this function
--    returns the SPECIFIC channel a subscriber is asking for (e.g.
--    `row:orders:abc-123`), not the pattern.
CREATE POLICY users_subscribe_own_rows ON realtime.channels FOR SELECT
TO authenticated USING (
  pattern = 'row:orders:%'
  AND EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = NULLIF(split_part(realtime.channel_name(), ':', 3), '')::uuid
      AND o.user_id = auth.uid()
  )
);
CREATE POLICY users_subscribe_own_list ON realtime.channels FOR SELECT
TO authenticated USING (
  pattern = 'list:orders:%'
  AND split_part(realtime.channel_name(), ':', 3) = auth.uid()::text
);
-- Messages need a SELECT policy for subscribers to read their stream:
CREATE POLICY users_read_messages ON realtime.messages FOR SELECT
TO authenticated USING (true);

-- 4. Publish trigger. SECURITY DEFINER so the trigger can INSERT into
--    realtime.messages even when the calling role cannot.
CREATE OR REPLACE FUNCTION public.notify_<table>()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM realtime.publish(
    'row:<table>:' || NEW.id::text,
    TG_OP,
    jsonb_build_object('new', to_jsonb(NEW),
                       'old', CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END)
  );
  PERFORM realtime.publish(
    'list:<table>:' || NEW.user_id::text,
    TG_OP,
    jsonb_build_object('id', NEW.id, 'status', NEW.status)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, realtime;

DROP TRIGGER IF EXISTS <table>_realtime ON public.<table>;
CREATE TRIGGER <table>_realtime
  AFTER INSERT OR UPDATE ON public.<table>
  FOR EACH ROW EXECUTE FUNCTION public.notify_<table>();
```

Register the migration in `system.custom_migrations` (the `statements` column is `text[]` — pass `ARRAY[$sql$...$sql$]`, not a plain string).

#### Frontend wiring template

```tsx
useEffect(() => {
  if (!rowId) return;
  const channel = `row:orders:${rowId}`;
  let handler: ((p: { channel: string; event: string; payload: { new?: Row } }) => void) | null = null;
  let cancelled = false;

  (async () => {
    await insforge.realtime.connect();
    if (cancelled) return;
    const sub = await insforge.realtime.subscribe(channel);
    if (!sub.ok) {
      // `sub.error` is only present when ok is false — TS won't narrow
      // automatically from a simple truthy check on `sub.ok`.
      console.warn("subscribe failed", "error" in sub ? sub.error : null);
      return;
    }
    handler = (p) => {
      if (p.channel !== channel) return;
      if (p.payload?.new) setRow(p.payload.new);
    };
    insforge.realtime.on("UPDATE", handler);
    insforge.realtime.on("INSERT", handler);
  })();

  return () => {
    cancelled = true;
    if (handler) {
      insforge.realtime.off("UPDATE", handler);
      insforge.realtime.off("INSERT", handler);
    }
    insforge.realtime.unsubscribe(channel);
  };
}, [rowId]);
```

#### Gotchas

- **`on(event, cb)` is GLOBAL across subscribed channels.** If you subscribe to `order:A` and `order:B` on the same SDK instance and register one UPDATE handler, it fires for both. Always filter by `payload.channel` inside the handler.
- **`SubscribeResponse` is a discriminated union** — `{ok: true, channel}` | `{ok: false, channel, error}`. Calling `sub.error` on a truthy-ok check fails TS narrowing; use `"error" in sub ? sub.error : null`.
- **No `postgres_changes` event filter equivalent.** Supabase's `filter: "id=eq.X"` → InsForge equivalent is "put X in the channel name" (`row:orders:X`). You express the filter by naming, not by parameter.
- **Anon users will always get UNAUTHORIZED** for policies scoped `TO authenticated`. Good default — if your app uses anonymous realtime, write a separate `TO anon` policy.
- **`realtime.channel_name()` returns the concrete name being subscribed to**, not the pattern. Use it in the policy USING clause to extract the per-row / per-user id segment; use `split_part(channel_name(), ':', N)` to parse.
- **Polling as a migration stopgap is fine** — pick 3-5s intervals scoped to the relevant useEffect lifecycle. But don't ship polling long-term without flagging the latency delta vs. the Supabase baseline.
- **Register each migration in `system.custom_migrations`** after applying (the `statements` column is `text[]`, pass `ARRAY[<sql>::text]`). `pg_read_file` is superuser-only on managed InsForge — read the file into a local variable and embed as a dollar-quoted literal instead.

#### Verification steps (copy-paste)

```sql
-- Channel registered + enabled:
SELECT pattern, enabled FROM realtime.channels WHERE pattern LIKE '%<table>%';

-- Policies in place:
SELECT policyname FROM pg_policies WHERE schemaname='realtime';

-- Trigger attached (not just the set_updated_at builtin):
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.<table>'::regclass AND NOT tgisinternal;

-- End-to-end: insert+update, inspect messages:
INSERT INTO public.<table> (...) VALUES (...) RETURNING id \gset t_
UPDATE public.<table> SET status='X' WHERE id = :'t_id';
SELECT channel_name, event_name, payload FROM realtime.messages
WHERE channel_name LIKE 'row:<table>:' || :'t_id' ORDER BY created_at;
-- Cleanup so you don't pollute dev data:
DELETE FROM public.<table> WHERE id = :'t_id';
DELETE FROM realtime.messages WHERE channel_name LIKE '%' || :'t_id' || '%';
```

The final piece (authenticated subscribe + receive over WS) needs a real user session. Create a throwaway user via the admin API, flip `auth.users.email_verified=true` with psql (the only way to skip verification — `autoConfirm: true` in the signup request is silently ignored on modern InsForge), sign in, subscribe, trigger a DB change from the backend, assert the event lands. Cleanup with `DELETE FROM auth.users WHERE email = ...` at the end.

### F. The AST rewriter needs to pick up project references

Vite + React with a split `tsconfig.json` / `tsconfig.app.json` / `tsconfig.node.json` is the default Lovable/Vite setup. `new Project({tsConfigFilePath: "tsconfig.json"})` loads the ROOT config only — which has `"files": []` and project references. The script silently rewrites 0 files.

Fix: point ts-morph at `tsconfig.app.json` (or whichever config actually lists source files):

```ts
const p = new Project({ tsConfigFilePath: "tsconfig.app.json" });
```

The skill's AST script snippet should call this out explicitly for Vite/Lovable apps. Previous (stet) trial used Next.js which has a single `tsconfig.json` with sources, so this didn't surface.

### G. `Database<T>` generated types port cleanly when the schema is 1:1

`src/integrations/supabase/types.ts` generated from `supabase gen types typescript` is usable as-is against InsForge *if* the migration preserved the schema exactly (same tables, same columns, same enums). Just move/copy the file to `src/integrations/insforge/types.ts` and update imports. Don't regenerate unless InsForge has a type-gen CLI and the schemas have diverged.

### H. Vite env vars — framework-specific prefix and access

Vite exposes env vars prefixed `VITE_` via `import.meta.env.VITE_*` (NOT `process.env.*`). Stet's Next.js migration notes about `NEXT_PUBLIC_*` do not carry over. Canonical env rewrite for Vite:

| Supabase (Vite) | InsForge (Vite) |
|---|---|
| `VITE_SUPABASE_URL` | `VITE_INSFORGE_URL` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` / `VITE_SUPABASE_ANON_KEY` | `VITE_INSFORGE_ANON_KEY` |
| `VITE_SUPABASE_PROJECT_ID` | (drop — not needed) |

Framework detection → env prefix map (for the skill to use when bootstrapping the new `client.ts`):

| Framework | prefix | access |
|---|---|---|
| Vite (React/Vue/Svelte) | `VITE_` | `import.meta.env.VITE_*` |
| Next.js | `NEXT_PUBLIC_` | `process.env.NEXT_PUBLIC_*` |
| Nuxt 3/4 | `NUXT_PUBLIC_` (public) / `NUXT_` (private) | `useRuntimeConfig().public.*` / `useRuntimeConfig().*` |
| Astro | `PUBLIC_` | `import.meta.env.PUBLIC_*` |
| Create React App | `REACT_APP_` | `process.env.REACT_APP_*` |

### I. Getting the InsForge anon key (Vite / non-CLI path)

If the project is already deployed and there's no `.insforge/project.json` locally, skip `npx @insforge/cli secrets get ANON_KEY` and use the admin HTTP API directly:

```bash
curl -sS "$INSFORGE_URL/api/secrets/ANON_KEY" -H "Authorization: Bearer $INSFORGE_ADMIN_KEY"
# {"key":"ANON_KEY","value":"eyJhbGciOi..."}
```

This assumes you have the `ik_...` admin key from the migration. Document it in the orchestrator's credentials checklist.

### J. Build is the typecheck

Vite's `vite build` does NOT run `tsc`. Pre-existing type errors (undeclared columns, missing discriminator map cases) silently pass build. `tsc -p tsconfig.app.json --noEmit` is the real typecheck gate — run it, and if it finds errors, confirm they predate the migration (via `git stash` / branch check) before declaring migration-unrelated and moving on. Never edit unrelated pre-existing type errors as part of the migration commit.

### K. Smoke test matrix worth running after every trial

Minimum Playwright suite (see `tests/smoke.spec.ts` in the rayaboy trial):
- Landing renders with zero `supabase` script src and zero console errors *other than* the expected `getCurrentUser()` 401 on anonymous load.
- `/login`, `/signup`, `/reset-password` render their forms.
- Signup form POSTs to `/api/auth/users` with the expected body shape.
- Login with wrong creds produces a visible "Login failed" toast *and* the network request hits `/api/auth/sessions`.

Filter expected noise: the browser will log `Failed to load resource: 401` from the SDK's initial `getCurrentUser()` call before a user is signed in. Match and exclude that specific error; don't gate on "zero console errors".

## Hard lessons from a real Nuxt trial (wdabt, 2026-04-26)

Full migration of `https://github.com/monid-ai/what-did-agents-buy-today` (Nuxt 4 + `@nuxtjs/supabase` + Vercel AI SDK + pg_cron worker app) to InsForge project `wtf-are-agents-buying`. New learnings beyond the stet (Next.js) and rayaboy (Vite) trials.

### A. Minimal-touch rewrite trick: have `useSupabaseAdmin()` return `client.database` directly (wdabt trial, 2026-04-26)

When the server-side helper exposes `client.database` (the InsForge SDK's database namespace), existing call sites using `.from(`, `.rpc(`, `.select`, `.insert`, `.update`, `.delete`, chained filters work unchanged. Single-file change to the helper avoids rewriting every server route.

```typescript
// app/server/utils/supabase.ts (the only file that needed editing)
import { createClient } from '@insforge/sdk'
type InsforgeClient = ReturnType<typeof createClient>
type InsforgeDatabase = InsforgeClient['database']
let _client: InsforgeClient | null = null
export function useSupabaseAdmin(): InsforgeDatabase {
  if (_client) return _client.database
  const config = useRuntimeConfig()
  _client = createClient({
    baseUrl: config.public.insforgeBaseUrl,
    anonKey: config.public.insforgeAnonKey || '',
    isServerMode: true,
    edgeFunctionToken: config.insforgeApiKey,
  } as Parameters<typeof createClient>[0])
  return _client.database
}
```

Server-side admin auth uses `isServerMode: true` + `edgeFunctionToken: <ik_API_KEY>`. PostgREST honors the `ik_…` API key as `project_admin`.

### B. Insert array-wrap is OPTIONAL on InsForge SDK 1.2.5+ — single object works (wdabt trial, 2026-04-26)

Earlier skill text said "array wrap required". Verified against `npx @insforge/cli docs db typescript`: both `.insert({...})` and `.insert([{...}])` are documented and work on SDK ≥ 1.2.5. The AST script can skip the array-wrap pass for SDK ≥ 1.2.5 — saves work on legacy code.

### C. `@nuxtjs/supabase` removal — Nuxt-specific call sites (wdabt trial, 2026-04-26)

| Was | Replace with |
|---|---|
| `useSupabaseClient()` (auto-imported by module) | `useNuxtApp().$insforge` (provided by a `app/plugins/insforge.client.ts` plugin) |
| `useSupabaseUser()` | `$insforge.auth.getCurrentUser()` (returns `{data:{user}, error}`) |
| `supabase.channel(...).on('postgres_changes', ...)` | InsForge realtime — see realtime archetype below |
| `supabase.channel(...).on('presence', ...)` / `.track(...)` | No direct equivalent. Rebuild via per-client `realtime.publish` heartbeat (or drop) |
| `import type { RealtimeChannel } from '@supabase/supabase-js'` | drop — not needed, InsForge realtime uses string channel names |
| nuxt.config `modules: ['@nuxtjs/supabase']` + `supabase: {...}` | drop both |
| `runtimeConfig` keys `supabaseUrl/supabaseKey/supabaseServiceKey` | rename to `insforgeBaseUrl/insforgeAnonKey/insforgeApiKey` |
| env `NUXT_PUBLIC_SUPABASE_URL` / `NUXT_PUBLIC_SUPABASE_KEY` / `SUPABASE_SERVICE_KEY` | `NUXT_PUBLIC_INSFORGE_BASE_URL` / `NUXT_PUBLIC_INSFORGE_ANON_KEY` / `NUXT_INSFORGE_API_KEY` |

### D. Nuxt plugin pattern for client-side singleton (wdabt trial, 2026-04-26)

```typescript
// app/plugins/insforge.client.ts
import { createClient } from '@insforge/sdk'
export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const client = createClient({
    baseUrl: config.public.insforgeBaseUrl,
    anonKey: config.public.insforgeAnonKey,
  })
  return { provide: { insforge: client } }
})
```

Then components/composables use `const { $insforge } = useNuxtApp()`.

### E. Global-feed realtime pattern — single channel, no per-user filter (wdabt trial, 2026-04-26)

Much simpler than the per-row pattern in the rayaboy notes. Use this when a public feed broadcasts to all clients:

```sql
-- migrations/<ts>_realtime-feed-channel.sql
INSERT INTO realtime.channels (pattern, description, enabled)
VALUES ('feed:new', 'Public feed broadcast', true)
ON CONFLICT (pattern) DO UPDATE SET enabled = EXCLUDED.enabled;

CREATE OR REPLACE FUNCTION public.notify_feed_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM realtime.publish('feed:new', 'INSERT_feed', to_jsonb(NEW));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, realtime;

DROP TRIGGER IF EXISTS feed_realtime_publish ON public.feed;
CREATE TRIGGER feed_realtime_publish
  AFTER INSERT ON public.feed
  FOR EACH ROW EXECUTE FUNCTION public.notify_feed_insert();
```

Frontend:

```typescript
await $insforge.realtime.connect()
const sub = await $insforge.realtime.subscribe('feed:new')
if (!sub.ok) { console.warn('subscribe failed', 'error' in sub ? sub.error : null); return }
$insforge.realtime.on('INSERT_feed', (payload) => prepend(payload as FeedItem))
```

No RLS needed if the feed is public — InsForge realtime is permissive by default. Add `ALTER TABLE realtime.channels ENABLE ROW LEVEL SECURITY` only if the channel must be access-restricted.

### E1. Realtime WS auth: JWT (anon key or user JWT), NOT the admin `ik_…` API key (wdabt trial, 2026-04-26)

The InsForge realtime WebSocket validates the bearer as a JWT. The admin API key (`ik_<hex>`) is a project-scoped opaque token, NOT a JWT — passing it as `edgeFunctionToken` for the realtime client fails the handshake with `Invalid token` even though the same client successfully calls `client.database.*` and `client.ai.*`.

If the same code path needs both admin DB calls AND a realtime subscription, use **two clients**:

```typescript
// admin client — for .database, .ai, .storage, .functions with project_admin scope
const admin = createClient({
  baseUrl, anonKey,
  isServerMode: true,
  edgeFunctionToken: API_KEY,  // ik_…
} as Parameters<typeof createClient>[0])

// realtime client — anon-only; the WS upgrades using anonKey as a valid JWT
const ws = createClient({ baseUrl, anonKey })
await ws.realtime.connect()
await ws.realtime.subscribe('feed:new')
ws.realtime.on('INSERT_feed', handler)
```

Symptom when wrong: `subscribe` returns `{ok: false}` (or the connection drops) with `error: "Invalid token"`. The trigger still fires server-side and `realtime.messages` populates correctly — the failure is purely on the WS subscriber, not on the publish path. Verify by `SELECT count(*) FROM realtime.messages WHERE channel_name = '<channel>'` after a known INSERT before debugging the subscriber.

### F. Vercel AI SDK (`ai` package) → InsForge AI is a clean swap (wdabt trial, 2026-04-26)

The Vercel AI SDK Gateway pattern:

```typescript
import * as AISDK from 'ai'
const { text } = await AISDK.generateText({
  model: AISDK.gateway('xai/grok-4.1-fast-non-reasoning'),
  system: SYSTEM_PROMPT,
  prompt: userPrompt,
  maxTokens: 120,
})
```

becomes (OpenAI-compatible chat completions on the InsForge AI gateway):

```typescript
import { createClient } from '@insforge/sdk'
const client = createClient({ baseUrl, anonKey, isServerMode: true, edgeFunctionToken: apiKey } as Parameters<typeof createClient>[0])
const completion = await client.ai.chat.completions.create({
  model: 'anthropic/claude-3.5-haiku',  // verify available models per project
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ],
  maxTokens: 120,
})
const text = completion.choices?.[0]?.message?.content ?? ''
```

Drop `@vercel/analytics` and `@vercel/speed-insights` separately if used — they are independent of the AI SDK swap. Keep `nitro: { preset: 'vercel' }` if deploying via `npx @insforge/cli deployments deploy` — that path still uses Vercel as the underlying runtime, just managed/billed through InsForge.

### G. Pitfall: `pnpm remove @nuxtjs/supabase` fails postinstall (wdabt trial, 2026-04-26)

`pnpm remove @nuxtjs/supabase` fails postinstall because `nuxt prepare` reads `nuxt.config.ts` which still references the dropped module. Edit `nuxt.config.ts` to drop `'@nuxtjs/supabase'` from `modules` BEFORE running `pnpm remove`, or expect a postinstall failure (the dependency is removed, but the lockfile/types step errors). Order matters: config edit → install.
