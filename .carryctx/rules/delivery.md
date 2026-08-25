# Delivery rules

1. The primary lifecycle is GitHub Issue -> CarryCtx team/task/dependencies/
   scopes/session -> isolated branch/worktree -> commit -> pull request ->
   independent review plus CI -> merge -> `bitty-docs` synchronization -> final
   checkpoint -> Issue and task closure.
2. Link the Issue and task. Map ownership to a team, ordering to dependencies,
   edits to scopes, active work to a named session and progress, recovery points
   to checkpoints, and ownership transfer to handoffs.
3. Start only dependency-ready work. Record decisions, blockers, risks,
   compatibility evidence, validation, and remaining gaps while work is active.
4. After the first commit, use a dedicated branch and worktree for independent
   implementation or substantial documentation work.
5. Before the first commit, branch/worktree/commit/PR stages are unavailable.
   The commander may use a shared checkout only for initialization with explicit
   disjoint scopes, preserved unrelated changes, and CI-equivalent local checks.
6. A pull request states Issue/task links, host/API outcome, security and
   compatibility impact, docs/examples, validation, dependencies, and cross-
   repository ordering.
7. Review is independent from implementation. Reviewers inspect the diff,
   accepted host contract, denial and lifecycle cases, synchronized docs, and
   reproducible CI evidence.
8. Documentation synchronization is part of definition of done. Public API,
   types, capabilities, package, compatibility, deprecation, or release changes
   remain incomplete while canonical `bitty-docs` content is stale.
9. Merge only after required findings and CI failures are resolved. A self-
   report or partial check is not acceptance evidence.
10. After merge, record the revision and final evidence in a checkpoint, close
    the Issue, complete the task, and create explicit follow-up tasks for
    separately authorized work.
