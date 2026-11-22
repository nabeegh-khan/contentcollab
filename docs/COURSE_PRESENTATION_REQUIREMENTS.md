# ECE1779 presentation requirements (course pages, read 22 Nov 2026)

Every tab working on the presentation, slides, demo or recording reads this file first. Sources, checked 22 Nov 2026:
- Logistics: https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/presentation/presentation-logistics/
- Rubric: https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/presentation/presentation-rubric/
- Guidelines: https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/presentation/presentation-guidelines/
- Side note: https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/presentation/side-note/
- Common questions: https://www.eecg.utoronto.ca/~cying/courses/ece1779-cloud/project/common-questions/

## Dates and logistics
- Written introduction: 70 to 100 words on Quercus, due Mon 23 Nov 11:59pm. Project name with a one-sentence purpose, target users or use case, one or two core features, key cloud technologies. It fills the peer-review form and the course website.
- Slides are submitted on Quercus and the team must present from the submitted file. Typo fixes only after the deadline; no content changes.
- Progress shown is as of Tue 24 Nov. Sessions Wed 25 Nov and Wed 2 Dec; all members attend both and score every other team.
- Arrive 13:00 to test the display; class starts 13:10. One laptop for the whole talk, display mirrored, USB-C or HDMI. Everything (slides, browser tabs, backup clip) open before our turn. The next three teams sit in the front row.
- 6 minutes, hand signal at 5:00, hard stop at 6:00. About 2 minutes of Q&A (usually one question and a follow-up). 1 minute changeover.
- Common questions: a team may have one or two presenters. Everyone must be ready for Q&A.

## Rubric (20 points, 10% of the grade; peers 5%, instructor and TAs 5%)
- Clarity and communication, 6: purpose, stateful design, technical choices, delivery in our own words (not reading a script), clear Q&A.
- Technical progress and demonstration, 10: containerized multi-service app; PostgreSQL and persistent storage with how state survives a restart or redeploy; orchestration (deployment, service management, replication, scaling); monitoring and observability (metrics, logs, dashboards or alerts, and what they reveal). Top band needs an effective live demo, with recordings only as a supplement.
- Advanced features and completion plan, 4 (scale 4, 2, 1, 0): at least two, purpose and design and how they fit the system; implemented ones demonstrated; unfinished ones with a concrete, feasible plan.
- Scorers judge only what is shown or explained. More features do not earn more points; clarity, integration and evidence do.

## Live demo rules
- A meaningful live demo of at least one working part is required. A fully recorded talk is not allowed. Short clips may back up network-dependent parts; narrate them while they play.
- Show evidence, not a page opening. A few actions, not a product tutorial.
- A live cloud deployment is not required; local Compose or minikube is acceptable.
- Monitoring that is graded: provider tooling (for example DigitalOcean metrics or alerts) and basic alerts or dashboards on key metrics. Prometheus and Grafana are optional. Showing metrics or logs in our own frontend is explicitly allowed.

## Team decisions (Sat 21 Nov meeting and Nabeegh, 22 Nov)
- No terminal, bash, PowerShell or kubectl on screen during the talk: one typo can sink the demo. Everything is driven from the frontend: admin sign-in, the operations panel (orchestration state, pod status, monitoring charts), the restart button, the Prometheus and Grafana view, state recovery after the restart, data persisting, and two advanced features.
- The demo is about 75 seconds.
- Show two advanced features live even though four are done.
- The backup is a recorded MP4 of the same click path, ready in VLC on the presenting laptop (or embedded in the deck) by Tue 24 Nov.
- Speaker notes keep the cues that point the audience at the slide ("top left", "bottom left", "on the left", "on the right"). Only internal stage directions to ourselves are removed.

## Slide rules
- Readable from the back row: large high-contrast text, legible labels in every diagram, table, terminal or dashboard capture. No screenshot too small to read.
- Short phrases, one main idea per slide, highlight the part of a capture that matters.
- Put the most important evidence early; nothing key in the last 30 seconds.

## Q&A
Direct answer, then the reason or evidence, then the trade-off. Say plainly what is untested or unfinished.
