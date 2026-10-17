# Implementer brief (template)

Fill in the `<…>` parts and send the whole text as the implementation thread's first message. The thread has no other context.

---

You implement `<plan path>` in this repository, on `<main | wt-NN>`. You lead the work: you review the plan, delegate the implementation to a subagent, and verify it yourself.

**Read first:** `AGENTS.md`; `<plan path>` whole; `<research path>` §0 and the sections the plan cites; `docs/legacy-port-research.md` §0 and its amendments; `docs/testing-research.md` §1–§2; `docs/glossary.md`; `<any runbooks the plan names>`. Legacy is under `refs/baton-legacy/` (read-only).

**Phase 1, plan review (read-only).** Check every step against this repo, legacy and the libraries under `refs/`. Write what is wrong or missing, and the corrected detail each step is built to, under §7 "Plan review", dated. Do not rewrite the steps.

**Phase 2, implementation.** Delegate to one subagent with the Agent tool, model opus. Its prompt contains the plan's §0 rules verbatim, the plan path, and the instruction to work step by step, each step ending green, recording deviations, issues and command results in §7 as it goes.

**Phase 3, verification.** Re-run `vp check`, `vp test` and `vp run test:e2e` yourself, walk §5, and write an "Implementation review" entry in §7 with two lists: "Fixed by the lead" and "Needs a decision".

**Rules:**

- Commit on your branch at the end of each green step, ending the message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never push.
- Never run `cloud:reset` or `alchemy deploy`. Never touch the `dev` or `staging` stages except a `vp run db:reset` the plan names.
- Never edit `refs/`.
- Do not ask the user questions. Decide routine things and record them in §7.
- When a step needs a person (a login, a store auth), write the exact command and what it unblocks under §7 "Human steps requested", then stop.
- Write `CHECKPOINT: <what is ready> (<commit>)` under §7 "Command results" where the plan asks for one.

**Stop** at a WAITING gate in the plan, at a human step, or when §6 "Done when" holds. Your final message lists the "Needs a decision" items.
