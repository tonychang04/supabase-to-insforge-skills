#!/bin/bash
# Supabase pg_dump schema → modern InsForge (minimal transform)
#
# Rules applied:
#   1. Strip SET statements (session settings — may fail on InsForge)
#   2. Strip COMMENT ON (not required, can fail on unknown objects)
#   3. Rewrite service_role → project_admin (role name differs)
#   4. Append admin bypass policies for project_admin on every RLS-enabled table
#      (project_admin is subject to RLS — unlike Supabase service_role)
#
# Intentionally NOT applied (differs from reference repo — those transforms are
# wrong against modern InsForge):
#   - auth.uid() stays (target has auth.uid())
#   - auth.users FK rewrites (no FK in this source references auth.users)
#   - uid() rewrite (source uses auth.uid() consistently)

set -euo pipefail
IN="${1:-supabase-schema.sql}"
OUT="${2:-insforge-ready.sql}"

# Strip SET + COMMENT, rewrite role, fix extensions schema refs
sed -E \
  -e '/^SET /d' \
  -e '/^COMMENT ON /d' \
  -e '/^CREATE SCHEMA /d' \
  -e 's/service_role/project_admin/g' \
  -e 's/extensions\.gen_random_bytes/public.gen_random_bytes/g' \
  -e 's/extensions\.uuid_generate_v4/public.gen_random_uuid/g' \
  -e 's/"extensions"\."gen_random_bytes"/"public"."gen_random_bytes"/g' \
  -e 's/"extensions"\."uuid_generate_v4"/"public"."gen_random_uuid"/g' \
  "$IN" > "$OUT.body"

# Fix function ordering: pg_dump emits CREATE FUNCTION before CREATE TABLE, but
# SECURITY DEFINER / STABLE functions that reference tables will fail at creation.
# Use awk to extract CREATE FUNCTION...$$; blocks and append them AFTER all tables.
awk '
BEGIN { in_fn=0; fn_buf=""; }
/^CREATE FUNCTION / { in_fn=1; fn_buf=$0 ORS; next; }
in_fn && /\$_?\$;/ { fn_buf=fn_buf $0 ORS; print fn_buf > "'"$OUT.fns"'"; in_fn=0; fn_buf=""; next; }
in_fn { fn_buf=fn_buf $0 ORS; next; }
{ print; }
' "$OUT.body" > "$OUT.body2"

# Insert functions BEFORE the first CREATE POLICY (policies reference functions)
if [ -f "$OUT.fns" ]; then
  awk -v fnfile="$OUT.fns" '
    BEGIN {
      while ((getline line < fnfile) > 0) fn = fn line ORS
      close(fnfile)
      injected = 0
    }
    !injected && /^CREATE (TRIGGER|POLICY) / {
      print "-- === functions moved here (pg_dump emits them before tables) ==="
      print fn
      injected = 1
    }
    { print }
    END {
      if (!injected) {
        print "-- === functions (no CREATE POLICY found, appended at end) ==="
        print fn
      }
    }
  ' "$OUT.body2" > "$OUT.body"
  rm "$OUT.fns"
else
  mv "$OUT.body2" "$OUT.body"
fi
rm -f "$OUT.body2"

# Extract RLS-enabled tables
TABLES=$(grep -oE '^ALTER TABLE [^ ]+ ENABLE ROW LEVEL SECURITY' "$OUT.body" | awk '{print $3}' | sort -u)

{
  echo "-- ============================================"
  echo "-- Transformed from Supabase pg_dump"
  echo "-- Target: modern InsForge (auth.users, storage.objects, auth.uid())"
  echo "-- ============================================"
  echo "SET client_min_messages = WARNING;"
  echo "SET search_path = public, pg_catalog;"
  echo ""
  cat "$OUT.body"
  echo ""
  echo "-- ============================================"
  echo "-- Admin bypass policies for project_admin role"
  echo "-- (project_admin is subject to RLS — unlike Supabase service_role)"
  echo "-- ============================================"
  for t in $TABLES; do
    tname="${t##*.}"
    policy_name="project_admin_all_${tname}"
    echo "DROP POLICY IF EXISTS \"$policy_name\" ON $t;"
    echo "CREATE POLICY \"$policy_name\" ON $t TO \"project_admin\" USING (true) WITH CHECK (true);"
  done
} > "$OUT"

rm -f "$OUT.body"
echo "Transform complete: $(wc -l < "$OUT") lines → $OUT"
echo "  RLS tables covered: $(echo "$TABLES" | wc -l | tr -d ' ')"
