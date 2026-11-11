/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        --1.Users
        CREATE TABLE users (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            email VARCHAR(255) NOT NULL,
            password_hash TEXT NOT NULL,
            display_name VARCHAR(255) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE UNIQUE INDEX users_email_unique
            ON users (LOWER(email));

        --2. Documents
        CREATE TABLE documents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            title VARCHAR(255) NOT NULL,
            owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            current_version_id UUID,
            row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- 3. Document versions
        CREATE TABLE document_versions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            number INTEGER NOT NULL CHECK (number > 0),
            filename VARCHAR(255) NOT NULL,
            content_type VARCHAR(255) NOT NULL,
            size BIGINT NOT NULL CHECK (size >= 0),
            checksum VARCHAR(255) NOT NULL,
            object_key TEXT NOT NULL,
            uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            CONSTRAINT document_versions_number_unique
            UNIQUE (document_id, number),

            CONSTRAINT document_versions_checksum_unique
            UNIQUE (document_id, checksum)
        );

        -- Ensure the current version references an existing document version.
        ALTER TABLE documents
            ADD CONSTRAINT documents_current_version_fk
            FOREIGN KEY (current_version_id)
            REFERENCES document_versions(id)
            ON DELETE SET NULL;

        -- 4. Shares
        CREATE TABLE shares (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            link_token TEXT UNIQUE,
            role VARCHAR(20) NOT NULL
                CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
            expires_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            CONSTRAINT shares_subject_check
                CHECK (
                    (user_id IS NOT NULL AND link_token IS NULL)
                    OR
                    (user_id IS NULL AND link_token IS NOT NULL)
                ),

                CONSTRAINT shares_document_user_unique
                    UNIQUE (document_id, user_id)
            );

        -- 5. Comments
        CREATE TABLE comments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            version_id UUID NOT NULL
                REFERENCES document_versions(id) ON DELETE CASCADE,
            author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
            parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
            body TEXT NOT NULL,
            anchor JSONB,
            resolved BOOLEAN NOT NULL DEFAULT FALSE,
            row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),

            -- Increasing sequence for ordering comments within a version.
            sequence_number BIGINT GENERATED ALWAYS AS IDENTITY,

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            CONSTRAINT comments_version_sequence_unique
                UNIQUE (version_id, sequence_number)
        );

        -- 6. Comment mentions
        CREATE TABLE comment_mentions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            comment_id UUID NOT NULL
                REFERENCES comments(id) ON DELETE CASCADE,
            mentioned_user_id UUID NOT NULL
                REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

            CONSTRAINT comment_mentions_unique
                UNIQUE (comment_id, mentioned_user_id)
        );

        -- 7. Tags
        CREATE TABLE tags (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name VARCHAR(100) NOT NULL
        );

        CREATE UNIQUE INDEX tags_name_unique
        ON tags (LOWER(name));

        -- 8. Document tags
        CREATE TABLE document_tags (
            document_id UUID NOT NULL
                REFERENCES documents(id) ON DELETE CASCADE,
            tag_id UUID NOT NULL
                REFERENCES tags(id) ON DELETE CASCADE,

            PRIMARY KEY (document_id, tag_id)
        );

        -- Indexes for document list and lookup endpoints.
        CREATE INDEX documents_owner_id_idx
            ON documents(owner_id);

        CREATE INDEX documents_created_at_idx
            ON documents(created_at DESC);

        CREATE INDEX documents_updated_at_idx
            ON documents(updated_at DESC);

        -- Indexes for version history.
        CREATE INDEX document_versions_document_id_idx
            ON document_versions(document_id, number ASC);


        -- Indexes for share lookups and permissions.
        CREATE INDEX shares_document_id_idx
            ON shares(document_id);

        CREATE INDEX shares_user_id_idx
            ON shares(user_id);

        CREATE INDEX comments_parent_id_idx
            ON comments(parent_id);


        -- Indexes for mention notifications.
        CREATE INDEX comment_mentions_user_id_idx
            ON comment_mentions(mentioned_user_id);

        -- Indexes for tag filtering and document-tag lookup.
        CREATE INDEX document_tags_tag_id_idx
            ON document_tags(tag_id);
    `);
};



/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        -- Remove the circular foreign key first.
        ALTER TABLE documents
            DROP CONSTRAINT IF EXISTS documents_current_version_fk;

        -- Drop tables in reverse dependency order.
        DROP TABLE IF EXISTS document_tags;
        DROP TABLE IF EXISTS comment_mentions;
        DROP TABLE IF EXISTS comments;
        DROP TABLE IF EXISTS shares;
        DROP TABLE IF EXISTS document_versions;
        DROP TABLE IF EXISTS documents;
        DROP TABLE IF EXISTS tags;
        DROP TABLE IF EXISTS users;
    `)
};
