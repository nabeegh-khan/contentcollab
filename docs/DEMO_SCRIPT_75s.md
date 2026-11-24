# Demo script, 75 seconds (live, and the same path for the recorded backup)

For the Wednesday 2 December presentation (slide 5, live demonstration). Rules from `docs/COURSE_PRESENTATION_REQUIREMENTS.md`: no terminal, bash, PowerShell or kubectl on screen; everything is driven from the web app and the browser; a live demo is required and a recording is only a backup. The speaker is Nabeegh. The two demo accounts are named below and never written out with their passwords: the admin account `admin@contentcollab.app` (owner of the seeded document, allowed into the operations panel) and the reviewer account `reviewer@contentcollab.app` (commenter, refused by the operations panel).

What each step does was checked against the live site on 23 November 2026 through the API and the live URLs: 17 of 18 checks passed in the run, and the one failure (4b) was a wrong field name in the check itself; the same snapshot read again passes: `docs/evidence/2026-11-23-cloud-test.txt`. The clicks themselves have not been tried in a browser by this script; the first rehearsal does that.

## Set up before the slot (not part of the 75 seconds)

1. Two browser windows side by side on the presenting laptop, each half the screen, display mirrored. Left window: signed out, on `https://contentcollab.app/`. Right window: signed in as the reviewer, on the seeded document's version page (the address is in the local demo notes), showing "Comments".
2. In the left window, sign in as the admin once, post one comment on the seeded document ("Reviewed the architecture section"), and sign out again. The seeded document starts with no comments, and the restart step is only convincing if something is there to survive it.
3. Upload a small text file titled "Design review draft" as the admin, and do not share it. The share step needs one document the reviewer cannot see yet. If the reviewer can see it, remove that share before the slot.
4. Chrome has the admin's saved login for the sign-in page, and Grafana's admin login saved for `https://contentcollab.app/grafana/`, so no password is typed on stage. The Grafana sign-in is done once in Chrome ahead of time.
5. One practice restart of the database pod five minutes before the slot, so the pod and its image are warm; reload the right window afterwards. The pause was 13 seconds on the second run on 23 November, and the first run's first answer came only at 62 seconds (cause not proven); plan for up to a minute.
6. Do not merge or deploy in the 20 minutes before the slot: a deploy replaces the API pods.

## The path

Each line is one click or one short action. Times are seconds from the start; the whole path is 75 seconds.

| Time | Page | Do | The screen shows | Say |
|---|---|---|---|---|
| 0:00 | Sign in | Click the Email field, pick the saved admin login, click "Sign in" | The Documents page, "Signed in as" with the admin name, the seeded document and "Design review draft" in the list | "I sign in as the admin, through the Gateway." |
| 0:06 | Documents | Click "Operations" in the top bar | The Operations page: Containers (8 pods on 2 nodes), Autoscaler (API copies running: 2 of 2, may use 2 to 5), Nodes, Storage (database disk about 5 GiB, bound; documents, versions, comments), the CPU and memory charts, Recent events | "We watch the cluster from here, no terminal. Eight pods, two nodes, a disk for the database." |
| 0:15 | Operations | Click "Restart the database pod" | A question: "Restart the database pod?" with Cancel and Restart | "Now I stop the database on purpose." |
| 0:18 | Operations | Click "Restart" | The message "Kubernetes is stopping pod postgres-0. A new one will start: watch the events below." The cards may stay frozen until the database is back (the API is not ready while it is down) | "Kubernetes starts a new database pod on the same disk." |
| 0:23 | Operations | Click "Open Grafana for the details" (opens a new tab) | Grafana's ContentCollab dashboard: request rate, errors, latency, autoscaler replicas, node memory | "Meanwhile Grafana, a separate pod, shows request rate, errors and latency." |
| 0:33 | Grafana | Close the tab (Ctrl+W) | Back on Operations; wait a second for it to refresh: the postgres row is Running with an age of seconds and Recent events lists the restart. If the banner "The data on screen is older than 15 seconds" shows, the database is still coming back | "The new pod is running; its age is seconds." (If the banner shows: "the page is waiting for the database", and stay a few seconds longer.) |
| 0:39 | Operations | Click "Documents", then "Open" on the seeded document | The document page, with the comment posted before the slot still listed | "The document and its comment are still here. The data lived on the volume, not in the pod." |
| 0:47 | Document | Click "Back to documents", then "Share" on the "Design review draft" row | The share form with that document's id filled in | "Sharing and roles, our security feature. I pick the document and a person." |
| 0:53 | Documents | In the form type `reviewer@contentcollab.app`, choose the role "commenter", click "Share" | "Shared with reviewer@contentcollab.app as commenter." | "The role is enforced by the API: a viewer cannot comment, a commenter can." |
| 1:03 | Documents | Click "Open" on the seeded document, click the comment box, type "Approved", click "Add comment" | In the right window, without a reload, the new comment appears in the comments list | "Live comments, our real-time feature. The right window is another user, possibly on the other API pod, and the comment arrives through Redis with no refresh." |

Ends at 1:15 (1:03 plus 12 seconds for the last step). If the restart pause is longer than the Grafana minute, say so plainly ("the app pauses while the database pod comes back, up to a minute") and stay on Grafana a few seconds longer; the next step needs the new pod to be Ready.

## Why this order

The restart is the only step with dead time, so Grafana sits inside it. The team's first order put Grafana after the recovery; this script moves it before, so no seconds are spent waiting.

## What can go wrong, and the answer

- The share shows "already shared": the reviewer already had the document. Use a different untouched document, or remove the share.
- Grafana asks for a login: Chrome's saved login was not set. Skip the Grafana line, stay on the Charts section of Operations, and keep the sentence about request rate and latency for the charts there.
- The comment does not appear in the right window: the right window lost its connection. Reload it, then post again.
- The restart button is greyed: another drill ran less than a minute ago ("Next drill allowed in ... s").

## Optional: the job queue card

Once the pull request for #30 is merged and deployed, the Operations page has a "Job queue" card (jobs waiting for the worker). It reads 0 almost always, because nothing in the API enqueues jobs yet, so it adds nothing to the 75 seconds; leave it out of the script and use it only to answer "where do background jobs show up".

## The recorded backup

The same path, recorded once on the same laptop at 1920x1080 as an MP4, played in VLC, muted. It stays open on the laptop and is played only if the network or the site fails; the talk narrates it while it plays, as the course allows for short clips that back up a network-dependent part. The recording is made after a rehearsal that follows this table without a miss.
