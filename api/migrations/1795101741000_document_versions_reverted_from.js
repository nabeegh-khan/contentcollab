export const shorthands = undefined;

export const up = (pgm) => {
    pgm.sql(`
        -- Track the original version from which a version was reverted.
        ALTER TABLE document_versions
            ADD COLUMN reverted_from UUID;

        ALTER TABLE document_versions
            ADD CONSTRAINT document_versions_reverted_from_fk
            FOREIGN KEY (reverted_from)
            REFERENCES document_versions(id);

        -- Allow reverted versions to reuse an existing checksum.
        -- Original versions must still have unique checksums per document.
        ALTER TABLE document_versions
            DROP CONSTRAINT document_versions_checksum_unique;

        CREATE UNIQUE INDEX document_versions_checksum_unique
            ON document_versions (document_id, checksum)
            WHERE reverted_from IS NULL;
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        -- Remove the partial unique index.
        DROP INDEX document_versions_checksum_unique;

        -- Remove the self-referencing foreign key and column.
        ALTER TABLE document_versions
            DROP CONSTRAINT document_versions_reverted_from_fk;

        ALTER TABLE document_versions
            DROP COLUMN reverted_from;

        -- Restore the original checksum uniqueness constraint.
        ALTER TABLE document_versions
            ADD CONSTRAINT document_versions_checksum_unique
            UNIQUE (document_id, checksum);
    `);
};
