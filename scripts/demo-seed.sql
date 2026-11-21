-- Demo fallback (D28, #116): one document with one version, an owner share, and an optional commenter share,
-- so comments can be shown through the web client when uploads are not available. Rows only: the version
-- points at no file in Spaces, so Download fails for it. Users must exist already (register them first).
--
--   psql -v ON_ERROR_STOP=1 -v owner_email=ann@example.com -v second_email=bob@example.com -f scripts/demo-seed.sql
--
-- Prints the document id and version id for the address #/documents/<document_id>/versions/<version_id>.
-- Leave second_email as an empty string ('') for no second share. Running it twice makes a second document.

\if :{?owner_email}
\else
  \set owner_email ''
\endif
\if :{?second_email}
\else
  \set second_email ''
\endif

SELECT count(*) = 1 AS owner_found FROM users WHERE lower(email) = lower(:'owner_email') \gset
\if :owner_found
\else
  DO $$ BEGIN RAISE EXCEPTION 'owner_email does not match exactly one registered user'; END $$;
\endif

BEGIN;

-- One statement per step: a data-changing CTE cannot see rows another CTE of the same statement inserted,
-- so setting current_version_id has to be its own statement
INSERT INTO documents (title, owner_id)
SELECT 'Demo document', id FROM users WHERE lower(email) = lower(:'owner_email')
RETURNING id AS document_id, owner_id AS owner_id \gset

INSERT INTO document_versions
  (document_id, number, filename, content_type, size, checksum, object_key, uploaded_by)
VALUES (:'document_id', 1, 'demo.pdf', 'application/pdf', 0, 'seed-' || :'document_id', 'seed/' || :'document_id', :'owner_id')
RETURNING id AS version_id \gset

UPDATE documents SET current_version_id = :'version_id' WHERE id = :'document_id';

INSERT INTO shares (document_id, user_id, role) VALUES (:'document_id', :'owner_id', 'owner');

INSERT INTO shares (document_id, user_id, role)
SELECT :'document_id', id, 'commenter' FROM users
WHERE lower(email) = lower(:'second_email') AND id <> :'owner_id';

SELECT d.id AS document_id, d.current_version_id AS version_id,
       (SELECT string_agg(s.role, ',' ORDER BY s.role) FROM shares s WHERE s.document_id = d.id) AS shares
FROM documents d WHERE d.id = :'document_id';

COMMIT;
