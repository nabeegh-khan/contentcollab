# Competitor scan

Checked 11 November 2026. Scope: products teams use to review and approve documents, and what they imply for the advanced features on our board (version comparison #23, review decisions #24, AI assistant in the worker #26).

## What the products do

| Product | Review and approval | Versions | Reviewer access |
| --- | --- | --- | --- |
| Filestage | Named approval stages, sequential or parallel reviewer groups, due dates, reminders, custom decision options | Side-by-side compare, overlay and automatic text comparison on higher plans, a banner when an older version is opened | External reviewers do not need an account |
| Google Docs | Comments and suggested edits that reviewers accept or reject | Version history with the author of each change | View, comment or edit permission per person |
| Box | Box Relay routes a document to reviewers, then to signing, then to archive | Version history per file | Shared links and enterprise permissions |
| Dropbox | Comments on files, no built-in approval routing | File version history | Shared links |

## Patterns worth copying

1. **A decision belongs to the version that was reviewed.** Filestage ties each approval to the uploaded version, and workflow guides warn that an approval attached only to a mutable filename becomes misleading once the file changes. For #24: store the document version id with every decision, and show "approved on version 2, current version is 3" when a newer upload exists.
2. **Compare is the feature reviewers use on round two.** Filestage reviewers describe it as the way to confirm a requested change was made without losing earlier corrections. For #23: start with a text diff of extracted text for PDF versions and a side-by-side view for images, before any overlay mode.
3. **A review report is the audit trail.** Filestage exports a PDF of every comment and decision with who, what and when, tied to the file version. Our worker already runs background jobs, so an exportable review report is a natural job for the BullMQ worker.
4. **Reviewer status at a glance.** The common dashboard view lists who has responded, who is still pending and what is overdue. This needs the decision table from #24 and a due date on a review request; reminders can be a scheduled worker job.
5. **Reviewers without accounts.** Filestage lets external reviewers comment through a link. Our share links cover the access side; whether a link holder can comment is a design decision for the sharing owner.

## What we should not copy

- Multi-stage routing and custom approval workflows. Teams in the sources report that near-identical stage templates became harder to maintain than the review itself. One required approver set per document is enough for the course scope.
- Enterprise governance and e-signature. Out of scope.

## Open questions for the owners

- Should uploading a new version reset existing decisions, or keep them marked as made on an earlier version? The sources favour keeping them visible and labelled.
- Does a comment pin to a version or to the document? Filestage pins to the version, so feedback stays attached to what was reviewed.

## Sources

- Filestage, online proofing tools overview: https://filestage.io/blog/online-proofing-tools/
- Filestage, approval workflow guide: https://filestage.io/blog/approval-workflow/
- Filestage reviews on G2 (reviewer groups, compare versions, review report): https://www.g2.com/products/filestage/reviews
- Statpit, document review and approval software comparison, August 2026: https://statpit.com/best/document-review-and-approval-software/
- Listicler, Dropbox alternatives (Google Drive and Box Relay): https://listicler.com/alternatives/dropbox-alternatives
- Jet Admin, document approval workflow apps (decisions bound to the reviewed version): https://www.jetadmin.io/blog/best-document-approval-workflow-apps/
