# functions/

DigitalOcean Functions for ContentCollab (ARCHITECTURE D39, issue #180).

| Function | What it does | Called by |
|---|---|---|
| `compare/diff` | The line diff of two text versions (`lineDiff`, as in `api/src/lib/diff.ts`) | the API, in `GET /api/v1/documents/:id/versions/compare`, with the in-API diff as the fallback |

`packages/compare/diff/diff.js` is a copy of `api/src/lib/diff.ts` (the function is deployed from this folder and shares no code with the services): keep them in step.

## Test

```powershell
cd functions
npm test
```

## Deploy

CI deploys on a merge to `main` (`functions` job in `.github/workflows/deploy.yml`) when the secret `FUNCTION_AUTH_TOKEN`, the variable `FUNCTIONS_NAMESPACE` and a DigitalOcean API token with the `function:admin` scope (`DO_FUNCTIONS_TOKEN`, or the existing `DIGITALOCEAN_ACCESS_TOKEN`) exist; without them the job stops green with a warning.

By hand, with the value in an env file kept outside the repository:

```powershell
doctl serverless install
doctl serverless connect fn-<your-namespace-id>
doctl serverless deploy functions --env C:\path\outside\the\repo\fn.vars
doctl serverless functions get compare/diff --url
```

`fn.vars` holds one line, `FUNCTION_AUTH_TOKEN=<value>`. `project.yml` sets `webSecure` to that value, so callers must send it as the `X-Require-Whisk-Auth` header. The API reads the function's address and the same value from `FUNCTION_DIFF_URL` and `FUNCTION_AUTH_TOKEN` in `app-secrets`; with either missing it computes every diff itself.

## Measure

`scripts/measure-function.mjs` times ten parallel calls (each needs its own container), ten sequential calls and the same diff in-process. Its results are in ARCHITECTURE D39.
