/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * The audit record of the operations panel's restart drills (ARCHITECTURE D31). Expand only: one new
 * table, nothing existing is touched (D24). The row is written before the eviction is sent; `outcome`
 * is filled in afterwards and stays null if the database was already stopping.
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE ops_drills (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            actor_user_id UUID NOT NULL REFERENCES users(id),
            target TEXT NOT NULL CHECK (target IN ('api', 'postgres')),
            pod_name TEXT NOT NULL,
            outcome TEXT CHECK (outcome IN ('evicted', 'refused', 'failed'))
        );

        CREATE INDEX ops_drills_requested_at
            ON ops_drills (requested_at DESC);
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        DROP TABLE ops_drills;
    `);
};
