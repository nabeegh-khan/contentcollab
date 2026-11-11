# AI session log

Required by the ECE1779 project handout for the final deliverable: two to four AI interactions that meaningfully influenced the project. For each: the prompt, the response (trimmed or summarized if long), and one to three bullets on what the team did with it (what was useful, what was incorrect or incomplete, how it was verified, modified or replaced). Each of us appends our own entries under our name. Keep it to interactions that show judgment; routine wording help does not belong here.

Format per entry, from the handout:

```
## Session title (issue number)

### Prompt

### AI Response

### What Your Team Did With It
- ...
```

## Nabeegh

## Checking the 17 October architecture against current state (#16, #17), 21 October 2026

### Prompt

For each component in `docs/ARCHITECTURE.md` (DigitalOcean Kubernetes, ingress-nginx with cert-manager, Socket.IO with the Redis adapter across several API pods, PostgreSQL on a DigitalOcean Volume, Spaces), check the current documentation for anything retired or changed since the course material was written, say what several API replicas mean for Socket.IO, and estimate the monthly cost of the cluster on DigitalOcean.

### AI Response

ingress-nginx was retired in March 2026 with no further releases or security fixes; the Gateway API is the recommended replacement. Three options with trade-offs: the Gateway API with a maintained controller (supported path, new objects to learn), a DigitalOcean load balancer with its own certificate (fewest moving parts, path routing needs a second load balancer or a proxy), or keep ingress-nginx (most tutorials, unpatched). For Socket.IO, the Redis adapter relays broadcasts between pods but does not route connections, so a session needs affinity unless clients use WebSocket only, and the proxy idle timeout must exceed Socket.IO's 45 seconds. Cost about $46 a month for two nodes, a load balancer and a volume, control plane free.

### What Your Team Did With It

- Useful: the retirement was not known to any of us and it removed the ingress we had planned. The retirement date and the recommended replacement match the Kubernetes blog post linked in `docs/RESEARCH.md`, and the cost matches the DigitalOcean pricing page, checked before the cost split was proposed.
- Decision: keeping ingress-nginx was ruled out because unpatched software is not defensible in a Q&A; the two remaining options went into `RESEARCH.md` and two decision issues, and the 24 October meeting chose the Gateway API (#16).

## Socket.IO across API replicas (#17), 21 to 31 October 2026

### Prompt

What is the simplest way to run Socket.IO behind a load balancer with two or more API pods, given the Redis adapter is already in the design?

### AI Response

WebSocket-only transport on the client (`transports: ["websocket"]`), so round-robin balancing works and no session affinity is needed; sticky sessions are the alternative if the long-polling transport has to stay.

### What Your Team Did With It

- Not taken as given: on 24 October the team chose sticky sessions with the Redis adapter, because WebSocket-only drops the HTTP long-polling fallback that keeps clients connected on networks that block WebSockets, and kept WebSocket-only as the fallback if the Gateway controller cannot pin sessions.
- Incomplete: the answer did not consider whether our controller supports affinity at all. The 31 October check of the NGINX Gateway Fabric documentation found cookie-based session persistence is NGINX Plus only and an experimental Gateway API field, with only `ip_hash` in the open-source build, which breaks for users behind one shared IP. The decision went back to the 31 October meeting with that fact; the proposal records the 24 October decision as made, not implemented.

## Laying out the Kubernetes manifests (#32, PR #35), 31 October 2026

### Prompt

The course has covered Kubernetes in one lecture: Deployments, Services, persistent volume claims and the HorizontalPodAutoscaler. Our `compose.yaml` runs api, PostgreSQL and Redis locally with health checks and a named volume. How should the manifests be organised so minikube and DigitalOcean share one source without copying files, which probe and resource settings does each object need, and how do secrets stay out of the repository?

### AI Response

One Kustomize base with a `minikube` and a `doks` overlay: the overlays patch only what differs (replica count, image source, storage class, the Gateway). Each container gets a readiness probe, a liveness probe, CPU and memory requests and limits, a non-root user and a termination grace period so SIGTERM finishes work in hand. PostgreSQL is a StatefulSet with a volume claim template rather than a Deployment, because the pod name and its volume must stay paired across restarts. A PodDisruptionBudget keeps one API pod up during node maintenance. The ConfigMap mirrors `.env.example`; the Secret is committed only as `secrets.example.yaml` with placeholder values, and the real one is applied by hand. The deploy workflow builds and pushes the image on merge and skips the rollout while no cluster credentials exist; a CI job renders both overlays and validates them with kubeconform.

### What Your Team Did With It

- Beyond the lecture: Kustomize overlays, the StatefulSet, the PodDisruptionBudget and probe tuning were not covered in class, so each was checked against the Kubernetes documentation before use, and the manifests were written from this layout, then rendered with `kubectl kustomize` and validated with kubeconform against the Kubernetes 1.33 and Gateway API schemas; the same check runs in CI on every pull request.
- Corrected: a `PGDATA` override in the first draft was removed because `compose.yaml` lets the `postgres:18` image choose its data directory under the mounted volume, and the two environments must match.
- Found on minikube the same day: both api pods had been restarted once, because the liveness probe pointed at `/health` and failed while PostgreSQL was still starting. A dependency outage must not kill a healthy process, so liveness now checks only that the socket accepts connections and readiness keeps the dependency check. The autoscaler's `minReplicas: 2` had also overridden the overlay's single replica; the overlay now sets it to 1. The restart test passed: a row written, `postgres-0` deleted, the row read back from the recreated pod on the same claim.

## Test harness for the API (#38), 4 November 2026

### Prompt

Our API is TypeScript run as ES modules with tsx (NodeNext imports end in `.js`), and `server.ts` exports the app without listening. How do we run Jest and Supertest against it in CI with a real PostgreSQL and Redis, without adding a build step?

### AI Response

ts-jest with `useESM`, `.ts` treated as ESM, a `moduleNameMapper` that strips the `.js` suffix so imports resolve to the `.ts` files, and Node's `--experimental-vm-modules` flag in the test script. PostgreSQL and Redis as GitHub Actions service containers, with a `pg_isready` health check so the steps wait for the database, and `--runInBand` so tests that share a database do not interleave.

### What Your Team Did With It

- Changed: tests sit next to the file they test (`src/routes/health.test.ts`) rather than in a top-level `tests/` folder, because `tsconfig.json` sets `rootDir` to `src` and files outside it fail the typecheck; the layout in `api/README.md` was updated to match.
- Checked: the three tests (`/health` with both services up, the 404 error shape, the request counter on `/metrics`) were run locally against PostgreSQL and Redis before pushing, and lint, Prettier and the typecheck pass. With Redis stopped, the suite fails on test timeouts rather than at once (superseded 7 November: the suite now stops at once, see the entry below), which is why CI starts Redis as a service instead of relying on the client's reconnect.
- Kept out of the image: test files and the Jest config are listed in `api/.dockerignore`.

## Load test for the autoscaling extension (#69), 4 November 2026

### Prompt

For the autoscaling and high-availability extension in section 2.7, we need to step the request rate up against the deployed API and see when latency or errors climb, how many API replicas the HPA adds, and whether a rolling update under load drops requests. Can this be one script with no new dependencies, since the team runs it from different laptops?

### AI Response

A Node script using the built-in `fetch`: an open-loop request schedule at a fixed rate per step (so slow responses don't lower the offered load), p50 and p95 latency and the error rate per step, the ready replica count read with `kubectl` at the end of each step, and an optional mode that runs `kubectl rollout restart` halfway through a constant-load step and counts every failed request.

### What Your Team Did With It

- Checked locally against the API with PostgreSQL and Redis at 20 and 100 req/s (no errors, p95 10 and 22 ms); the replicas column shows "-" without cluster access, which is the intended fallback.
- Changed: the step-length variable is `STEP_SECONDS`, not `SECONDS`, because `SECONDS` is a built-in bash variable.
- Run on DigitalOcean on 6 November (two runs in `docs/loadtest/`, made with earlier versions of the script, see `docs/loadtest/README.md`). Added since: a check that the HPA can read CPU before a scaling run, a node-memory guard, and per-request failure and scaling logs.

## Review of the load test (#69, pull request #72), 10 November 2026

### Prompt

We reviewed our own load-test pull request against the diff, issue #69 and our practices, and checked each finding against the code before acting on it. We asked: where can this script report a clean result that is not true, and which columns can't support the conclusions we want to draw for the report?

### AI Response

Thirteen findings: a failed `kubectl rollout restart` was swallowed, so a rollout run could show 0 failed requests with no rollout; the rollout call blocked the request timer; "achieved req/s" was the rate requests were sent, not served; latency included failed requests; only 5xx counted as errors; bad environment variables produced NaN rows; p95 equalled the maximum for small samples; failures were timed when they ended; the Helm version check fell through to Helm 4 on any output; the CI job had no permissions or timeout; and the docs and the two committed CSVs no longer matched the script.

### What Your Team Did With It

- Checked each finding against the code and by running the script against a local stand-in server with no cluster before changing anything; all thirteen held.
- Changed: the rollout runs asynchronously and is waited on with `kubectl rollout status`; a failed or unfinished rollout is written to a `rollout` column and the run exits 1. New columns `sent_per_s` and `ok_per_s`; latency from successes only; any 4xx is a failure; nearest-rank percentiles; variables validated. Tests for the new helpers were written first and failed before the change.
- Kept: the two 6 November CSVs, labelled in `docs/loadtest/README.md` with the commit that produced them, instead of deleting them.
- Not covered: the rollout's success path needs the cluster, so it runs with the final measurements.

## Deploy pipeline and lecture 8 fixes (#59, #65, #70, #74), 4 November 2026

### Prompt

Lecture 8 says to use explicit image tags rather than `latest`, to name container ports, and to recover with `kubectl rollout undo`. Our cluster bring-up applied `latest`, our deploy workflow used a static kubeconfig secret, and the API waited for Redis before opening its port. What should change so a merge to `main` only ships tested code, the cluster never runs `latest`, and a bad release rolls itself back?

### AI Response

Render the overlay with the commit SHA substituted for `latest` and check the registry holds that tag before applying; name the port `http` and refer to it by name in the Service and probes; open the port before connecting to Redis so readiness, not a restart loop, handles the outage; call the pull-request checks from the deploy workflow; use DigitalOcean's doctl action with a kubeconfig that expires in 600 seconds; and roll back automatically when `rollout status` or a smoke check fails.

### What Your Team Did With It

- Checked against the sources: lecture 8 slides (p53-55, p67, p73, p76-81, p92, p106-111) and DigitalOcean's push-to-deploy guide, which uses `digitalocean/action-doctl` and `doctl kubernetes cluster kubeconfig save --expiry-seconds 600`. The static `KUBECONFIG` secret was dropped because a doctl kubeconfig authenticates through doctl itself.
- Tested: the API with Redis absent answered `/health` 503 and stayed up, then 200 once Redis started, in the same process; a CI step now repeats that against the built image. Both overlays render; the bring-up's registry check found the image for the current `main` commit.
- Kept as a condition: the smoke-and-rollback step runs only once a smoke URL is set, so deploys don't roll back before DNS and TLS exist.

## Gateway namespace fault and its CI check (#59), 4 November 2026

### Prompt

After bring-up the Gateway had no address in the `contentcollab` namespace, though every pod was running. Why, and how do we stop it happening again?

### AI Response

The Gateway and HTTPRoute were in `default`: a kustomization's `namespace` field covers only that kustomization's resources, and the DigitalOcean overlay adds the Gateway without setting one. Set the namespace in the overlay, add a CI step that fails when any rendered object other than the Namespace falls outside `contentcollab`, push the check before the fix so it can be seen failing, then move the live objects by creating them in `contentcollab` before deleting the copies in `default`.

### What Your Team Did With It

- Checked against the sources: Kustomize's `namespace` reference, the GitHub runner image list (yq preinstalled) and the NGINX Gateway Fabric v2.8.0 chart values, which is also where product telemetry, failing on every run, was turned off.
- Tested: CI failed on the check alone, naming `Gateway/contentcollab`, and passed with the fix. Recorded in `docs/BUILD_LOG.md`.

## Proposal freeze: review check and word budget (#9, #31, #33, #34, #66), 6 November 2026

### Prompt

The four sections are written and reviewed, and the file must be one Markdown document of at most 2,000 words, references included. My plan: merge each section's pull request with a merge commit so its author's history stays; check each section against every review comment, the handout and our architecture; fix what is open, naming the owner in each commit; trim my Section 2 to about 870 words without losing a table or handout item; and keep live updates as decided on 24 October. For each section, which review comments are still unanswered, which claims lack a source, and where can words go without losing a rubric item?

### AI Response

A list per section. Section 1: the tool claims had no sources, one citation pointed to a reference that did not exist, and the gap claim was too broad, because Acrobat's shared review and Hypothesis already offer live, anchored PDF comments. Section 3: nobody was named for a demo failure, the testing wording was generic, and the review rule disagreed with the README. Section 4: the ingress-nginx change and the reason behind the AI evaluation had been dropped. The response also suggested where to cut words in each section.

### What Your Team Did With It

- Checked against the sources, live on 6 November: the course handout (section requirements, the advanced-feature list, 2,000 words); Adobe's share-and-review page and Hypothesis's site for Section 1; and the NGINX Gateway Fabric 2.8 release blog and session-persistence docs, plus DigitalOcean's load-balancer docs. Those sources confirmed that cookie persistence is now open source but experimental. Sticky sessions stayed, and D12 records where affinity comes from.
- Not accepted as given: "closed per-seat services" for the competitors. Hypothesis's server is open source and Acrobat reviewers need no account, so Section 1 contrasts vendor-run services with a deployment we run and observe ourselves. The advanced features were set by the team: four committed, each with an owner, and backup and email as stretch goals.
- Counted: 1,970 words with table pipes and URLs removed (1,990 by `wc`); every reference is cited and every citation is defined.

## Spreading the API replicas across nodes (#69), 6 November 2026

### Prompt

The proposal says the API runs two replicas on two nodes for high availability, but on 4 November they landed on different nodes only by chance. My approach: state the rule in the architecture first, add a CI check that fails on the current manifests, then add the rule to the API Deployment, so the check shows it working. Which Kubernetes mechanism fits a Deployment that the autoscaler takes from two to five replicas on two nodes, and how do I check for it in CI?

### AI Response

Use a topology spread constraint on `kubernetes.io/hostname` with `maxSkew: 1` rather than required pod anti-affinity, which allows only one pod per node and would leave extra replicas and the rolling-update surge pod Pending. Prefer `ScheduleAnyway`, and add `matchLabelKeys: [pod-template-hash]` so each rollout revision spreads on its own. In CI, render both overlays and assert the constraint with yq. The first draft gave two wrong reasons. It said the scheduler's default allows a skew of 3, and that `ScheduleAnyway` was needed for single-node minikube.

### What Your Team Did With It

- Checked against the sources: the Kubernetes topology spread and node assignment pages, live on 6 November. The default spread does not score nodes missing a zone label, and `kubectl get nodes` showed our nodes have none, so the real reason is stronger than the first draft's. The `ScheduleAnyway` reason was corrected to a drained or lost node, because with one node the skew is zero either way.
- Tested: the check was pushed first and failed in CI (run 42286395192); with the constraint it passed (run 42287294841). An independent review also made the check assert `ScheduleAnyway` and the hash, which it had let slip.
- Left open in the pull request: `ScheduleAnyway` is a preference, and spreading is not rebalanced after a scale-down.

## Component diagram after the advanced-feature change (#69), 6 November 2026

### Prompt

Section 2.7 now commits four advanced features, but the diagram still shows two generic "Advanced feature" badges and "2 replicas". My plan: rename the existing badges to Security and CI/CD, add Real-time on Redis and Auto-scaling on the api in the same style, show the autoscaler's range on the api box, and re-render the PNG at the same size without changing the proposal text. Where do the new badges and the longer api title fit without covering lines or text?

### AI Response

At 21 px the new api title measures 357 px against a 270 px box, so widen the box to 330 px around the same centre and set that title at 18 px. Put the two api badges side by side, left of the line that leaves the box at x = 885. Move the Redis badge inside the cylinder top, because on the rim it would cover the arrowhead from the api. Size each badge to its text with the old badges' padding.

### What Your Team Did With It

- Measured rather than estimated: text widths came from the browser's own font metrics, and a script over the rendered SVG checked for overlapping text, badges covering other labels, and titles outside their boxes. It found none.
- Looked at the rendered PNG: every label is readable. The Gateway arrow still ends on the api badge, as it did before.
- Kept as it was: the image paths and captions in the README and the proposal; the proposal text and word count did not change.

## The autoscaler that could not read CPU (#69), 6 November 2026

### Prompt

Before running the load test on DigitalOcean I checked the HPA, and it showed `cpu: <unknown>`. My approach: record the cause and the fix in the architecture first, put the install in a pinned script rather than a dashboard click, and make the load test refuse to run while the autoscaler is blind, with a test written before the code. How should metrics-server be installed on DOKS, and how do we tell from the HPA's status that it is really reading CPU?

### AI Response

Install the upstream metrics-server chart at a pinned version, with the same two replicas and verified kubelet TLS that DigitalOcean's own Marketplace stack uses. Treat the HPA as ready only when its AbleToScale and ScalingActive conditions are True and a CPU utilization is reported. Build the test fixture from the live status, and have the load test stop on a real kubectl error but continue with a warning when no cluster is reachable.

### What Your Team Did With It

- Checked against the sources: DigitalOcean's HPA guide, the chart's Chart.yaml at tag 3.14.0, the metrics-server compatibility table (Kubernetes 1.34 and later) and DigitalOcean's Marketplace stack, which installs the same chart unpinned.
- Tested: the readiness test failed in CI before the module existed (run 42296688552) and passed after it (run 42297775626). On the live cluster the check reports `FailedGetResourceMetric` and the load test refuses to start.
- An independent review caught that `--atomic` is deprecated in Helm 4, that PowerShell's `bash` is WSL rather than Git Bash, and that any kubectl failure let the load test continue. All three were fixed. Kubelet TLS on our cluster remains unverified until the install runs.

## Proposal file renamed to the Quercus name, 7 November 2026

### Prompt

Rename `docs/PROPOSAL.md` to `docs/ECE1779_Team22_Project_Proposal.md`, the exact file every member submits on Quercus, without changing a byte of its content. Update every link in the repository, confirm the strict word count is still 1,999 and the sha256 still begins `d35d288f`, and push one commit to main under the docs rule.

### AI Response

Used `git mv` so Git records a rename rather than a delete and an add, updated the six links (the README tree and the 17, 24 and 31 October minutes), searched the whole repository for the old name, and compared the moved file with the committed one: the same 13,876 bytes and sha256, and 1,999 words once URLs, table rules and pipes are removed. Pushed as one commit, `dcd3786`.

### What Your Team Did With It

- Checked: `git grep` for the old name finds nothing; the raw GitHub URL for the new path answers 200 with 13,876 bytes; the word-count method is the one used for the freeze on 6 November, reproduced from its recorded totals.
- Kept: the content, byte for byte. Only the file name and the links changed.
- Open: the 6 November comment on #79 still names the old path at `d47d567`; it points at the same content.

## Test harness that says what is missing (#38, PR #71), 7 November 2026

### Prompt

A teammate ran `npm test` in `api/` and got three failures: a 5 s hook timeout and repeated empty `redis:` error lines. CI is green on the same branch. Explain the difference, answer the teammate, and make the suite fail with a clear message when the services it needs are not running, writing the test before the code.

### AI Response

The tests need a real PostgreSQL and Redis; CI starts both as service containers, the laptop had neither, and the Redis client's reconnect loop ran until Jest's hook timeout. Three defects were on our side: the test's comment named a compose service that does not exist, `compose.yaml` publishes neither port so no one-command local run existed, and the failure hid its cause. Proposed a 1 s TCP reachability check before the first test that names the service, host, port and the start command, a `compose.test.yaml` override that publishes both ports on localhost with the CI credentials on a separate volume, and Jest defaults for the connection variables.

### What Your Team Did With It

- Checked against the sources: Docker Compose "Merge Compose files" (volumes merge by mount path; environment and ports override) and the Jest `setupFiles` option, both read on 7 November.
- Tested: the reachability test failed in CI before the module existed and passes after it; the full suite passes locally against the override and in CI; with Redis stopped the suite now stops at once with `Redis unreachable at localhost:6379` and the compose command.
- Replied to the teammate with the cause and the command, and corrected the first reply the same day because its command did not publish the ports.


## Test harness names a refused credential (#38, PR #71), 7 November 2026

### Prompt

A teammate ran the suite with the compose override and got `bind: address already in use` on 127.0.0.1:5432; `/health` then answered 503 and one test failed. Explain it, answer the teammate, make the suite name the cause with the test written first, and have the change checked independently before it merges.

### AI Response

Their own PostgreSQL holds 5432, so the test container never started; the reachability check passed against that server and the test credentials were refused, which `/health` reports only as a 503. Proposed one `SELECT 1` before the first test that fails with host, port, user, database and the `TEST_DB_PORT=55432` remedy. The independent check added that network errors must keep the start-the-services message and that the query needs a timeout, and found a practice ID that does not exist.

### What Your Team Did With It

- Test first (failing in CI on 5931cef), module after; four cases covered (credentials accepted, refused, nothing listening, a server that never answers); 11 tests pass locally and in CI.
- Six findings from the independent check (misleading message on connection refused, missing public record, the practice ID `NET-2` that is CON-7, an unmentioned red CI run, the shared Compose project, no timeout) were fixed, then its re-check found that the timeout left a connect pending in the pool; fixed with a probe client of its own and a fourth test, and re-checked clean before the merge (3c53210).
- Replied to the teammate by editing the morning's comment, under the same-day rule.


## Datadog install reviewed and hardened (#27, PR #61), 8 November 2026

### Prompt

PR #61 had no review three days after it left draft. Bring it up to date with main, run every CI check locally, review it, fix each real finding in its own commit, check whether Datadog still fits the architecture, and prepare the self-review note and the merge.

### AI Response

Datadog still fits: the proposal and the diagram name it, but D6 still said Prometheus and Grafana. The review found an unpinned chart, a swallowed `helm repo add` failure, no wait for the agent, a silent skip, the API key in a process argument, no check that the key and site are right, a scrape setting that did nothing, kubelet TLS verification turned off without a source, and a step order that hid the Gateway address. An independent check of the result added the chart's unused operator, discovery and APM containers, the memory arithmetic, a missing timeout, and that server-side apply with kubectl's default field manager still keeps the annotation holding the key.

### What Your Team Did With It

- Merged main into the branch and kept only the Datadog lines in the two conflicted files. Fixed each finding in its own commit (pinned chart 3.269.1, `--repo`, `--wait`, key through stdin into a server-side-applied Secret with its own field manager, `GET /api/v1/validate` on `DATADOG_SITE`, unused chart parts off, cluster-agent requests).
- Tested the install step with stub `kubectl` and `helm` and real `curl`: skip, wrong key (Datadog 403), unknown site (HTTP 000), valid key never in a process argument. shellcheck clean; CI green.
- Corrected D6 on main and recorded the memory arithmetic as a stated risk. The merge waits for the review window, which ends 9 November at 10:08am.

## Gated deploy rebased and made compatible with the image pinning (#70, PR #76), 8 November 2026

### Prompt

PR #76 was stacked on #71, which was squash-merged, so it conflicted with main in seven files. Rebase only its own commit onto main, make its `deploy.yml` compatible with #83 so neither undoes the other, run the checks, review and fix it, rewrite the description and request review.

### AI Response

#76 had one commit of its own, on #71's first commit, so `git rebase --onto origin/main` left only `ci.yml` and `deploy.yml` changed. Proposed taking #83's rollout step as written and adding the checks before the build, short-lived doctl credentials, one rollout at a time and the smoke check. The review found practice IDs that do not exist (DEP-12, DEP-13), silent green runs when the token or `SMOKE_URL` is missing, undo loops that stop before the worker, no check that the pinned image reached the Deployment, a credential that can expire before the smoke rollback, and stale text about the old secret.

### What Your Team Did With It

- Rebased, then fixed each finding in its own commit; the second review pass found that an unreadable image ended the step, which a stub test case showed failing before its fix.
- A stub test of the rollout and smoke scripts under `bash -e` passes nine cases (four failed before the fixes); #83's own deploy test passes 9 of 9 on the two branches combined; CI green.
- Wrote the merge order (#83 first) and the exact conflict resolution into the description; review requested from a teammate, due 11 November.

## Redis-down start reviewed: /health answers at once and the reconnect is tested (#65, PR #75), 10 November 2026

### Prompt

Our fix for #65 opens the port before connecting to Redis. We reviewed it against the diff, the issue and our practices, and checked each finding against the code and the node-redis 6.3.0 source before acting. We asked: with Redis down, what does the kubelet actually see from /health, does the CI step prove Redis was the cause, and does the same process recover when Redis returns?

### AI Response

Eight findings. The main one: with Redis down, a ping waits in the client's offline queue for its 5 s command timeout, so the readiness probe (1 s default) times out instead of reading the 503. The other seven: the CI step accepted any 503 although the job has no Postgres, so it only proved the port was open; no curl or job timeout; the reconnect was claimed but not tested; no unit test covered the ping while Redis is down; every retry was logged (about one line every 2 s); the `.catch` message said "first connect failed" when, with the default retry strategy, connect() keeps retrying and does not reject; and a CI comment said the Redis service was there for a check nothing made. A second, independent pass found one more: once a command is written to the socket it has no timeout, so a paused Redis could still hold /health past 1 s.

### What Your Team Did With It

- Measured before changing anything: a ping to a closed port took 5009 ms; with a readiness guard, under 1 ms.
- Wrote a Jest test first (fails with "Exceeded timeout of 5000 ms"), then made `pingRedis` return false at once while the client is not ready.
- The CI step now reads the body within 1 s, then starts Redis on the API's port and requires `"redis":"ok"` from the same container with no restart. Run locally on a Docker network: passes on this branch, fails on the PR's previous head and on main.
- Errors are logged once per outage, with "connected" or "connected again" when Redis is back; the reworded `.catch` says when it can fire and what follows.
- For the paused Redis: a second test first (a ping that never settles), then a 500 ms limit on the ping. Against a real Redis under `CLIENT PAUSE 3000`: false in 501 ms, true again after the pause.

## Self-review of three cloud PRs while teammates build the core (#27, #55, #82; PRs #61, #62, #83), 10 November 2026

### Prompt

The 7 November meeting put the schema and core features ahead of reviews, so PRs #61, #62 and #83 were past their three-day windows with no review. Nabeegh's approach: bring each branch up to date with main, have it reviewed from the diff, the issue and the practices only, check every finding against the code before acting on it, fix the real ones test first, rerun every check, and record a self-review on each PR without merging. AI was used for the merges, the reviews, the fixes and stub tests, and the independent checks.

### AI Response

#61 (Datadog): the cluster agent could list every Secret in the cluster through two default ClusterRoles, every pod's logs went to Datadog, a rotated key never reached running agents, and `DATADOG_SITE` was unchecked. #83 (image pinning): the workflow tests passed on broken rollout steps (13 of 22 deliberate breakages at the first check), the bring-up pin check missed tagless, digest and hyphenated images, practice IDs cited rows that do not exist, and a Deployment left on the placeholder tag was never undone. #62 (smoke and alerts): `smoke.sh` could not pass against the deployed URL, accepted the Gateway's 404, and failed on a large `/metrics` body; `alerts.sh` left a rebuilt cluster without alerts.

### What Your Team Did With It

- Each fix came with a check that failed before it: a `helm template` render check, stub tests of the bring-up steps and of both scripts, and 52 changed copies of `deploy.yml` run against the test. Limits the test cannot see are written in the build log.
- Every round went back to a fresh reviewer until it came back clean. Later rounds caught an undo placed so it could go back one revision too far (fixed before the branch was pushed) and loose wording in the build log (corrected on `main`).
- One check by mistake ran the real `doctl` against the team account; DigitalOcean refused the only change it tried, and a read-only listing confirmed nothing was created. The test harness now refuses to run unless its stubs are the ones on PATH.
- Decisions went into ARCHITECTURE D6 and the build log on `main` before the branches were pushed. The PRs are not merged: that, and removing the requested reviewers, waits for Nabeegh.

## Bring-up script checked against current versions and made safe to re-run (#54, PR #94), 11 November 2026

### Prompt

Issue #54: the DOKS bring-up script (Gateway controller, cert-manager, the kubeconfig secret for CI). Check every component version and install path against kubernetes.io, DigitalOcean, cert-manager and NGINX Gateway Fabric docs first. Record the architecture choice in ARCHITECTURE.md and PRACTICES.md. Then harden the script with tests for re-runs, missing variables and a certificate that is not issued. Dry run only; no cluster created or deleted.

### AI Response

The pinned cert-manager (1.19) had reached end of life, and cert-manager 1.21 supports Kubernetes up to 1.36, while an unpinned DOKS create gets 1.37. cert-manager's guide recommends upgrading one minor version at a time, and the setting that enables Gateway API support changed name in 1.21. The running cluster is on 1.37 with cert-manager 1.19.2. DigitalOcean's documented CI pattern is a token plus a 10-minute kubeconfig, not a stored kubeconfig. Proposed changes: checks before any change, a dry-run mode, a stepwise cert-manager upgrade, a certificate wait with cert-manager's status on failure, and stub-driven tests.

### What Your Team Did With It

- Kept the token pattern the deploy workflow already used and recorded why in D13. Recorded the version pins with their sources, and kept the running 1.37 cluster: rebuilding it is the cluster owner's decision.
- Pushed the tests before the fix so CI showed them failing (11 of 13), then fixed the script.
- An independent review of the fix found three gaps (a certificate never created was reported as not issued, the worker rollout was not waited for, the Datadog path was untested in dry runs). Each got a test that failed first, then a fix.
- Ran the dry run against the real cluster and checked that nothing changed. The live upgrade and the CI token wait for Nabeegh.

## Schema contract test for the #37 checklist (#77), 11 November 2026

### Prompt

The schema in #37 carries every promise the proposal makes about data, so we wanted a CI test that fails when one goes missing. We asked for a test written against the #37 checklist and PR #88's migration, shown failing on a bad migration first, with its own claims mutation-tested by someone who had not written it.

### AI Response

A catalog-query checker with 13 checks, scratch databases for isolation, a bad-migration fixture and 15 single-promise changes. A fresh reviewer then changed the checker and the schema and found false passes: a role CHECK of `OR true` or `NOT IN` passed because the check compared quoted text, column types were not checked, any identity column counted as "increasing", and any table named like a mentions table passed.

### What Your Team Did With It

- Replaced the text comparison with a probe on a temporary copy of `shares` inside a rolled-back transaction (four roles accepted, seven other values refused), added type, step, cycle and per-version checks, and grew the change list to 38 rows, each run on #88's migration.
- Ran the test on the bad migration first (it failed, listing the six broken lines), then on #88's (43 of 43), and a second review round before opening the draft PR.
- Kept the one item not fixed (`EXISTS` can never be null, so a null guard has nothing to catch) out of the code and in the log.

## CI checks for the migration, the web image and the cloud manifests (part of #70, PR #99), 11 November 2026

### Prompt

The reviews of #88 and #86 promised four CI additions: kubeconform at a supported Kubernetes version, a migration up/down/up step, a web image build and a render check for the infra overlay and migrate Job. We asked for them as small scripts with tests written first, each shown failing on a deliberately broken input, and an independent review before pushing.

### AI Response

Three shell scripts with stub-driven tests (17), workflow changes that skip while the inputs are missing, and local runs against a real Postgres 18 and the real files from #88 and #86. A fresh reviewer then found that the workflow wiring was untested (7 of 7 changed copies passed), that a `yq | grep || true` hid a yq failure, and that the placeholder check missed digits.

### What Your Team Did With It

- Added a test that pins the workflow wiring and killed all of those changes, moved yq output to a file, widened the placeholder check, and re-ran everything.
- Showed the checks red then green on a runner with a throwaway branch (closed afterwards), and wrote the limits into the PR and the build log: skips that never expire, no check that `down 0` empties the history, a build-only web job.

## A rolling update that drains its pods, and a check that counts failed requests (#69, PR #103), 11 November 2026

### Prompt

Issue #69: prove that the API scales under load and that a rolling update drops no requests. Check the current Kubernetes documentation for the autoscaler, rolling updates, disruption budgets and pod shutdown, record the decision in ARCHITECTURE.md first, then add what is missing, a script that restarts the API under load and counts failed requests, and prove it on a cluster. The local cluster run was stopped for lack of memory, so the proof moves to the DOKS cluster after the rebuild.

### AI Response

The autoscaler, the disruption budget, `maxUnavailable: 0` and the readiness probe were already in the base manifest. The gap is shutdown: the endpoint removal runs alongside SIGTERM, and the API refuses new connections on SIGTERM. Proposed a 10-second `preStop` sleep (the built-in sleep handler, stable since Kubernetes 1.34) as a kustomize component, and a script that runs k6 inside the cluster. A local run showed `/health` fails under load with no rollout, so the script targets `/metrics`.

### What Your Team Did With It

- Wrote the decision into ARCHITECTURE D14 before the code, and corrected it when the plan changed (no local run) and when a review showed two of its claims were wrong: the 25% defaults already come to 0 and 1 for two replicas, and the memory risk was understated.
- Pushed each batch of tests before the code that satisfies it, so CI showed them failing: 4, 5 and then 6 cases. One case passed on the runner for the wrong reason (it matched bash's wording of an error) and was rewritten to check behaviour.
- An independent review found three ways the script could report a pass by mistake; each got a failing test first, then a fix.
- Did not run anything on the cluster: it does not exist yet. The demo page says so and lists what is unverified, and the pull request stays a draft until the numbers are in.

## PRACTICES alignment with the API contract, and lecture 9 rows (#104), 11 November 2026

### Prompt

`docs/PRACTICES.md` API-4 still described offset pagination with a `total`, while `docs/API.md` defines cursor pagination, and a review on #93 had promised to bring the row into line. Lecture 9 had just been posted. We asked for the row to match API.md with an honest source, for one row per lecture 9 practice with page citations, and for a list of what the manifests and code now miss, with no code changes.

### AI Response

A rewritten API-4 and seven new rows from all 98 pages of lecture 9. It found that no lecture or assignment sets a pagination scheme, so the old A1 citation was wrong. It also found one gap: the database volume's Delete reclaim policy, which it opened as #104.

### What Your Team Did With It

- Had the change checked by a new reviewer each round, one who had not written it or seen the earlier rounds, until a round came back clean. Each round checked the slides, the handouts, the manifests and the DigitalOcean and Kubernetes documentation. They found a blank line that broke the API table, a wrong cause for volume loss on cluster teardown (the `--dangerous` flag in `cluster-down.sh`, not the reclaim policy), planned work worded as done, an unsupported A2 citation, and a sentence about the cluster that went stale while the change was being checked. All were fixed before the commit.
- Left out of this change, and logged as open: an inconsistency inside `docs/API.md` (the API slice's file) and two older rows that no longer agree with the contract.

## PRACTICES rows for lectures 1, 7 and 9, page numbers rechecked (#105, #106), 11 November 2026

### Prompt

The lecture 9 rows had been cited against the 98-page note-taking PDF, while the team keeps the full slides. Lecture 7 had no rows and lecture 1 only two. We asked for every page of the three decks to be read, the lecture 9 citations to be checked against the full slides, rows to be added with page citations, and one issue to be opened for each real gap, with no code changes.

### AI Response

A page map between the two lecture 9 files (two slides are split over two pages in the full version, so citations after p9 move by one, and after p37 by two), corrected citations, six new rows (INF-18 to INF-21, PRC-5, PRC-6) and lecture 1 and 7 pages added to existing rows. It found two gaps: migrations are not required to keep the old API version working during a rolling update (#105), and local scripts do not check the kubectl context (#106).

### What Your Team Did With It

- Checked each new row against the manifests and scripts before writing where it applies, and dropped lecture 1 citations the slides did not support (for "demo live", "pay for what you use" as a reason to destroy resources, and contribution read from Git history).
- Had the change checked by reviewers who had not written it, a new one each round, and fixed what they found (a migration Job described as existing when it is only planned, a script listed as calling kubectl that does not, a row still placing the cluster in Toronto after the move to nyc3) before committing.

## Two more review passes on the request log and the monitoring scripts (#55, PR #102), 11 November 2026

### Prompt

PR #102 (JSON request logs, bounded metric labels, the error-rate check and the memory-headroom script) had one review. Before it can merge we asked for two more independent passes, the second by a reviewer who had not seen the first: every test shown failing without its change, the error paths (no data, bad input, crash), the log format and label bounds, and every claim in the PR and in D18. Each fault fixed test-first; nothing pushed until the second pass was clean.

### AI Response

The first pass found about thirty items. The most serious were silent all-clears: a node with no reading counted as 0 MiB used, a failing probe below the minimum reported as fine, unreadable lines dropped, a late server error logged as the client aborting. It also found tests that passed with the feature removed and a CRLF README. The second pass found no code fault that blocked a push, but it did find plain-text startup lines, untested bounds, environment-dependent tests and several doc claims that were wrong or stale.

### What Your Team Did With It

- Wrote a failing test for each finding before the fix, in five rounds, and added checks that would have caught the late faults: line endings read from git's index, `--tail=-1` in every documented command, and the logger's output parsed by the check itself.
- Brought the error bodies in line with our own API contract (`code`), made both scripts exit 2 instead of reporting all clear on bad input, and ran the real server with Redis paused to see the alert fire.
- Corrected D16, D18, RESEARCH and the demo page where they had gone stale after the cluster rebuild. Left the architecture diagram and the submitted proposal's Datadog line unchanged.
- Rejected one suggestion: counting aborted requests as failures. They get their own column instead, because a closed browser tab is not a server error.

## The bring-up script follows the rebuilt cluster (#54, PR #94), 11 November 2026

### Prompt

The bring-up script on #94 creates the cluster without `--ha`. Make it create without the paid high-availability control plane and with node autoscaling. Then make it match the rebuilt cluster: its node pool and version, the region and context read from the cluster (nyc3), and the Gateway API CRD opt-out that DOKS 1.37 needed. Write the tests first, record the decision in D13 with sources, and re-check the CI/CD evidence page against the Actions API.

### AI Response

Checked DigitalOcean's doctl reference, its high-availability how-to, its pricing page and its Gateway API guide. Omitting `--ha` turns HA on for 1.36.0 and later, at US$40 a month, and it cannot be turned off. The opt-out for DOKS-managed Gateway API CRDs is the annotation `doks.digitalocean.com/install-policy=external` on each CRD. Proposed `--ha=false`, autoscaling bounds checked before any call, the rebuild's defaults, the context taken from the cluster's own region, and the annotation step before the CRD apply, each with tests. Every run, duration and count on the CI/CD evidence page matched the API.

### What Your Team Did With It

- Committed each batch of tests before its fix: 2 of 30 failed, then 6 of 36. All pass now.
- Did not set the node pool defaults until the rebuild recorded its actual values, then copied them from that record.
- An independent review found a test that could not fail on one of its claims, a missing default test and a misleading sentence in D13. All three were fixed before the push.
- A second review of the final change found an untested warning, a stale paragraph in D13 and two inaccurate sentences in the build log, one of them saying a lint tool was unavailable when it was not. All four were fixed before the push.
- Noted the deploy path-filter gap on #70 instead of editing `deploy.yml`, because another open pull request changes that file.
