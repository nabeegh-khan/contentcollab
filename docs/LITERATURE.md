# Literature notes

Fourteen papers collected on 17 October for the proposal. Each note says what the paper found (from its abstract, or the thesis abstract for Brush) and what it means for ContentCollab. The PDFs are in the team's shared Papers folder; the notes are here so anyone can cite them. Section 1 (motivation) can draw on the synthesis at the end.

## Annotation and asynchronous review

**Cadiz, Gupta and Grudin (2000), "Using web annotations for asynchronous collaboration around documents," CSCW 2000.** About 450 members of a Microsoft product team made 9,239 shared annotations on 1,243 documents over ten months with Office 2000 web annotations. Interviews showed what worked and what did not in the built-in tools. *For us:* teams do review documents through in-place comments when the tool supports it; this is the closest real-world evidence for the review-workspace idea.

**Weng and Gennari (2004), "Asynchronous collaborative writing through annotations," CSCW 2004.** Most digital annotation systems assume the document does not change and offer less than paper annotation. The authors define an annotation life cycle and version control for annotations. *For us:* comments need a state (open, resolved) and must survive new versions of the file.

**Brush (2002), "Annotating digital documents for asynchronous collaboration," PhD thesis, University of Washington.** Three findings. In a graduate class, students wrote twice as much discussion as annotations as on a bulletin board, and the discussion focused on specific points. Notifications in a large commercial annotation system were inadequate; adding richer notification content, several channels and customisation increased awareness of activity. When a document changes, users judge an annotation's new position by whether the unique words they annotated are still there, which led to the Keyword Anchoring algorithm. *For us:* @-mentions and email notifications matter for adoption, and pins should be carried forward to the matching position in a new version.

## Collaborative editing (operational transformation and CRDTs)

**Preguiça and Shapiro (2008), "Designing a commutative replicated data type for cooperative editing," technical report.** Introduces commutative replicated data types (CRDTs), where concurrent operations commute so replicas converge without concurrency control, and Treedoc, with background consensus to clean up metadata.

**Ahmed-Nacer et al. (2011), "Evaluating CRDTs for real-time document editing," DocEng 2011.** Replays real peer-to-peer editing logs on several CRDTs and finds them suitable for real-time editing, with differing time and space costs.

**Liu et al. (2014), "Formal verification of operational transformation."** Model-checks operational transformation (OT) algorithms for convergence and intention preservation; the first complete verification of OT control algorithms and transformation functions.

**Nedelec, Molli and Mostefaoui (2016), "CRATE: writing stories together with our browsers," WWW 2016.** A browser-only real-time editor tested with up to 600 browsers, combining algorithms to balance space, time and communication cost.

**Bauwens and Gonzalez Boix (2019, 2020), memory-efficient CRDTs.** CRDT metadata can grow without bound; both papers remove metadata earlier (when nodes join, and once operations are causally stable) to reduce memory.

**Sun et al. (2020), "Real differences between OT and CRDT in correctness and complexity for consistency maintenance in co-editors," PACM HCI (CSCW).** A critical review finding that OT, not CRDT, underlies most working co-editors, and that CRDT claims of superiority do not hold up.

**Attiya et al. (2021), "Specification and space complexity of collaborative text editing," Theoretical Computer Science.** Proves that list protocols for collaborative text editing, including OT and CRDT protocols, need metadata at least linear in the number of deleted elements.

*For us, the whole group:* live co-editing is a hard, still-debated research problem with real memory costs. This is the evidence behind keeping co-editing out of scope (proposal 2.8) and building review on versions instead.

## Replication and consistency

**Li et al. (2015), "Minimizing coordination in replicated systems," PaPoC 2015.** Coordination is the price of keeping replicas consistent; the paper identifies the minimum ordering each pair of operations needs.

**Bezerra et al. (2016), "Strong consistency at scale."** Partitioning state scales single-partition operations, but operations across partitions pay a coordination overhead that grows with the number of partitions.

**Ahmed et al. (2023), "Consistency issue and related trade-offs in distributed replicated systems and databases: a review," Radioelectronic and Computer Systems.** Reviews the consistency-latency trade-off that follows from the CAP and PACELC theorems: strong consistency needs coordination between replicas, which adds latency.

*For us:* a single PostgreSQL instance with transactions gives strong consistency without cross-replica coordination; the API scales because it holds no state (proposal 2.3 and 2.4).

## Synthesis for section 1 (motivation)

- **Feedback scatters.** Without in-place annotation, review happens in email and chat, away from the exact spot in the document; in-place annotations focus discussion on specific points (Cadiz 2000; Brush 2002).
- **Versions break comments.** Most annotation systems assume a static document, so comments lose their place when a new version arrives (Weng 2004; Brush 2002).
- **People miss activity.** Built-in notifications in commercial tools were found lacking; awareness improved when notifications carried more content and reached people on several channels (Brush 2002).
- **Real-time co-editing is the wrong fix for review.** It is costly and contested (Sun 2020; Attiya 2021), and a team reviewing at different hours needs versions, anchored comments and notifications more than simultaneous typing.
