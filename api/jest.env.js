// Defaults for a local `npm test`: the services that compose.test.yaml starts,
// with the same credentials ci.yml gives its service containers. Variables
// already set (as in CI) win.
process.env.DB_HOST ??= "localhost";
process.env.DB_PORT ??= process.env.TEST_DB_PORT ?? "5432"; // TEST_DB_PORT: the host port compose.test.yaml publishes
process.env.DB_USER ??= "test";
process.env.DB_PASSWORD ??= "test";
process.env.DB_NAME ??= "contentcollab_test";
process.env.REDIS_HOST ??= "localhost";
process.env.REDIS_PORT ??= "6379";
