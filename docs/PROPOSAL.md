# ContentCollab: project proposal

ECE1779 Introduction to Cloud Computing, Fall 2026. Due Saturday 7 November 2026, 11:59pm. One Markdown file, at most 2,000 words. Drafted in the shared Google Doc; each section's owner moves the settled text here.

Team: Nabeegh Khan (1001388152), Milton Wang (1009114192), Jyotiraditya Kale (1013397370), Yiqing Liu (1008052580).

## 1. Motivation

Owner: Eyrika. Problem, intended users, why it is worth addressing, limitations of existing approaches.

## 2. Objectives, architecture and key features

Owner: Nabeegh. From `ARCHITECTURE.md`: objectives and core functionality, the architecture, how each required technology is used, the advanced features, scope and feasibility.

## 3. Project plan and team responsibilities

Owner: Milton. From `PLAN.md`: stages, division of work, integration strategy, dependencies and coordination, risks.

	For this project, we will divide it into multiple parts, with each person agreeing to different responsibilities and doing a roughly equal amount of work. Eyrika will be working on the API, tags, and email notifications. Jyotiraditya will be working with Eyrika on the API as well as on the live updates. Milton will work on the front end, backups, and API documentation. Nabeegh will work on the cloud orchestration and the CI/CD pipeline. 

	We will integrate the components by weekly milestones where the branches are merged and run together, checking the linked Issues on Github on backend to frontend dependencies, and catching blockers during our weekly meetings. 

	To avoid leaving things to the last minute, we will be regularly developing and testing the application whenever we have time. We will also coordinate, check in, and ask for help through the WhatsApp group chat and during the weekly group meetings (Saturdays at 3:30 p.m). We will use the Issues on the Github repository and assign reviewers for each other’s work to verify that it is functional. We will first work on the skeleton, then the core features and cloud, before proceeding to the real-time features and additional features if we have time - we plan on stopping building any new features on November 21st to rehearse the demonstration. We will use unit and integration tests in the continuous integration and do weekly piloting from November 14.

	We are also aware that risks and unexpected issues may arise. These include a feature or stage slipping, a late feature, pod or volume losses, or issues with deployment. We have devised plans to handle those situations and mitigate their impacts. This includes excluding additional features that do not work from the demonstration, those who are ahead taking up work on open issues, and using the pg_dump backup to prevent volume loss.


## 4. Initial team reasoning and AI-assisted exploration

Owner: Jyotiraditya. Initial understanding (10 October notes), technical hypotheses, open questions, how the thinking changed, one AI interaction with its evaluation, how the final proposal differs from the initial thinking.
