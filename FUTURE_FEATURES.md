# Future Features (deferred)

Features explicitly deferred from the MVP (project-management spec §8). Do not implement
these during the MVP without a documented reason in `DECISIONS.md`.

| Feature                             | Why deferred                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Elaborate web dashboard             | MVP needs CLI/skill reporting only. When a dashboard is built, it follows ADR-009 (simple, pixelated, Lego-block pieces). |
| Cloud-hosted orchestration          | Conflicts with local-first default (ADR-008).                                                                             |
| Team collaboration                  | Not needed to prove the core concept.                                                                                     |
| User accounts                       | BYOK + local-first needs no accounts.                                                                                     |
| Subscription billing                | BYOK: the project does not resell model access.                                                                           |
| Enterprise administration           | Post-MVP.                                                                                                                 |
| Complex analytics                   | MVP needs per-task and total cost only.                                                                                   |
| Custom agent marketplace            | Post-MVP ecosystem work.                                                                                                  |
| Remote execution infrastructure     | Local execution with worktrees first.                                                                                     |
| Advanced autonomous agent discovery | MVP uses configured providers and models.                                                                                 |
| Large-scale benchmarking platform   | MVP needs a basic capability feedback loop only (ADR-008 #5).                                                             |

## Proposed scope expansions

None yet. New ideas that arise during development are recorded here with date and source.
