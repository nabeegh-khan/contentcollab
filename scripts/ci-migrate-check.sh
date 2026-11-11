#!/usr/bin/env bash
# Runs the migrations up, all the way down, and up again against the database
# the PG* variables point at (the API job's Postgres service in CI), and fails
# on any error. A migration whose `down` leaves an object behind fails the
# second `up` ("already exists"); a missing `migrate` script or a SQL error
# fails the first. It ends on `up`, so Jest then runs against a migrated schema.
# Skipped while api/migrations does not exist (#37). Run from api/.
# Practices DB-9, TST-1, TST-5. `down 0` reverts every migration: a bare `down`
# reverts one (node-pg-migrate CLI reference, checked 11 Nov 2026).
set -euo pipefail

dir=${MIGRATIONS_DIR:-migrations}
if [ ! -d "$dir" ]; then
  echo "api/$dir does not exist yet (#37): migration check skipped"
  exit 0
fi

step() {
  local label=$1
  shift
  echo "::group::migrate $label"
  if ! npm run migrate -- "$@"; then
    echo "::endgroup::"
    echo "::error::migrate $label failed: the migrations do not survive up, down, up"
    exit 1
  fi
  echo "::endgroup::"
}

step "up" up
step "down 0" down 0
step "up after down" up
