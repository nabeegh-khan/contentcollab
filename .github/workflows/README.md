# workflows

GitHub Actions. `ci.yml` runs on every pull request: lint, typecheck, api tests against a PostgreSQL service container. `deploy.yml` runs on merge to `main`: build the images, push to the GitHub Container Registry tagged by commit SHA, `kubectl set image` on the cluster and wait for the rollout. Cluster credentials are repository secrets. Owner: Nabeegh.
