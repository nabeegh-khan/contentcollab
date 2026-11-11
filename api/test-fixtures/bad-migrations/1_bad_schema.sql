-- Up Migration
-- A schema that breaks six lines of the #37 checklist on purpose (#77):
--   users.password_hash is nullable, shares.role also allows 'admin',
--   document_versions has no unique (document_id, checksum), comments has
--   no row_version, nothing stores mentions, document_tags has no foreign keys.
-- The contract test must report exactly those six.
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT
);
CREATE TABLE documents (
  id UUID PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES users(id),
  row_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE document_versions (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id),
  checksum TEXT NOT NULL
);
CREATE TABLE shares (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id),
  link_token TEXT UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'commenter', 'viewer', 'admin')),
  expires_at TIMESTAMPTZ
);
CREATE TABLE comments (
  id UUID PRIMARY KEY,
  parent_id UUID REFERENCES comments(id),
  anchor JSONB,
  sequence_number BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE TABLE tags (id UUID PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE document_tags (document_id UUID NOT NULL, tag_id UUID NOT NULL);

-- Down Migration
DROP TABLE document_tags, tags, comments, shares, document_versions, documents, users;
