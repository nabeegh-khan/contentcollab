# worker

Background jobs that must never run inside an API request: bulk imports from an existing bucket or folder, thumbnails, the nightly backup trigger. Consumes a BullMQ queue on Redis; has the same database and Spaces access as the API and nothing else. Owner: the additive-features slice (see `docs/PLAN.md`).
