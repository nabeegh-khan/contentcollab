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
