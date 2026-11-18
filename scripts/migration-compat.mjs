// Fails when a migration's up drops or renames a table or column without a contract marker (#105, ARCHITECTURE D24).
// Stub: finds nothing yet, so the tests in migration-compat.test.mjs fail first.
export function findViolations() {
  return [];
}
