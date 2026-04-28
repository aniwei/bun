---
name: rfc-to-todos
description: 'Methodology for RFC/RFS design-to-todos workflows. Use when: designing a phase from RFC/RFS, gathering reference knowledge, converting designs into TODO trackers, auditing progress at 25% gates, validating TODO evidence, recalculating progress, or syncing affected docs and test matrices.'
---

# RFC To Todos Methodology

Use this skill when a design document, RFC, RFS, technical design, or architecture note needs to be turned into an executable TODO tracker, or when an implementation change must be reflected back into the TODO/RFC documentation set.

## Core Rule

Treat RFCs and technical design documents as the design source of truth, and TODO trackers as the execution ledger. A TODO entry should explain what is implemented, what is still missing, which files or modules own the behavior, what tests or reviews prove it, and which design assumptions were checked.

## Reference Knowledge Rule

When designing a phase, feature, or TODO slice, do not invent the design from a blank page if no reference knowledge was provided.

1. First look for local references:
   - Relevant RFC/RFS or technical design docs.
   - Existing TODOs from adjacent phases.
   - Similar code paths, tests, compatibility docs, demos, examples, or acceptance cases.
   - Repository memory notes when available.
2. If local references are insufficient, search the repository for similar implementations or ask a search/knowledge subagent to gather comparable patterns.
3. If there is still no reliable reference, ask the user for a knowledge base, prior design, target product behavior, or similar project to use as a reference.
4. Record the chosen reference basis in the TODO evidence or design notes when it affects architecture.

Do not mark a design slice as ready when its reference basis is unknown and the missing knowledge could change interfaces, ownership, or validation strategy.

## Inputs To Read

1. Read the relevant RFC, RFS, technical design, or architecture document.
2. Read the matching phase TODO tracker.
3. Read compatibility docs, acceptance matrices, demo/example docs, or public API references when the work touches exposed behavior.
4. Read existing implementation and tests before changing completion percentages.
5. Read repository or session memory when it may contain prior decisions, caveats, or recurring validation rules.

## TODO File Shape

Each phase TODO should keep these sections in order:

1. Title and phase summary.
2. Status, total completion percentage, latest test status, dependencies, execution strategy.
3. Links to corresponding RFC/design docs, acceptance matrices, examples, and relevant design sections.
4. Start checklist with design checks, code style, and prerequisites.
5. TODO table.
6. Phase completion standard.
7. Status update rules.

The TODO table columns should be:

```markdown
| ID | 状态 | 完成百分比 | 测试通过 | 文件/模块 | 功能介绍 | 完成时设计核对 |
| --- | --- | ---: | --- | --- | --- | --- |
```

## Row Semantics

- `ID`: Use stable phase-prefixed IDs like `P3-04` or the local project's established ID format. Do not renumber existing IDs unless the user explicitly asks.
- `状态`: Use `Not Started`, `In Progress`, or `Done`.
- `完成百分比`: Use a conservative integer percent. Do not mark `100%` unless the completion standard and tests are satisfied.
- `测试通过`: Use `Pass`, `Fail`, or `Not Run`.
- `文件/模块`: List concrete files/modules that own the behavior.
- `功能介绍`: Describe the target capability, not just the latest patch.
- `完成时设计核对`: Summarize implemented evidence and remaining gaps. Avoid overclaiming.

## Progress Calculation

Phase total completion is the arithmetic average of all row percentages, rounded to the nearest integer.

Use a parameterized command to verify the header against the table. Set `TODO_FILE` to the phase TODO tracker being edited:

```sh
TODO_FILE=<path-to-phase-todo.md>
awk -F'|' '/\| [A-Z]+[0-9]+-[0-9]+ / { gsub(/ /, "", $4); gsub(/%/, "", $4); sum += $4; count += 1 } END { printf "count=%d sum=%d average=%.2f rounded=%d\n", count, sum, sum / count, int(sum / count + 0.5) }' "$TODO_FILE"
```

After changing row percentages, update the header `总完成百分比` to the rounded value.

## Update Workflow

1. Identify the RFC/design requirement being implemented or documented.
2. Map it to existing TODO rows; create a new row only when the requirement has a distinct owner, test surface, or completion criterion.
3. Check reference knowledge. If none was provided, gather similar local knowledge or ask the user for a reference before locking the design.
4. Implement the smallest verifiable slice first.
5. Classify validation for every affected TODO:
   - Code behavior or quantitative output: add or update an executable test.
   - Documentation, architecture, or qualitative-only outcome: provide a model-reviewed qualitative verification summary with explicit evidence.
6. Synchronize all affected docs:
   - TODO row evidence and remaining gaps.
   - Compatibility matrix entries for public APIs.
   - Demos, examples, or user-facing matrices for visible coverage.
   - RFC only when the design or hook/timing decision changes.
7. Recalculate total progress.
8. Run the focused test first, then the phase or full check required by the change.
9. Update the TODO header test status with the latest verified command result.

## 25% Phase Review Gates

At every 25% boundary of a phase, pause and review the technical design and code before increasing progress beyond the boundary.

Required gates:

- Crossing `25%`: Verify the TODO table maps to RFC/design sections and that each row has an owner module and validation approach.
- Crossing `50%`: Re-read the technical design and inspect the main code paths. Confirm implemented slices still match the intended architecture.
- Crossing `75%`: Re-read the design, tests, compatibility docs, and visible coverage. Confirm remaining gaps are explicit and completion criteria are still measurable.
- Crossing `100%`: Re-read the design and code end-to-end. Confirm all Done criteria, tests, docs, compatibility entries, demos, and examples are synchronized.

For each gate, record a short review note in the TODO or final work summary: design docs reviewed, code paths checked, validation status, and unresolved risks.

Do not advance a phase past a 25% gate if the design/code review has not happened.

## TODO Validation Rule

Every TODO row needs explicit validation evidence.

Use executable tests when the TODO is code-related or quantitatively measurable:

- Runtime/API behavior.
- Parser/build output.
- File system state.
- Compatibility matrix entry.
- Demo, example, or acceptance-case metadata.
- Numeric progress or generated artifact.

Use qualitative model-reviewed verification only when no meaningful executable test can exist:

- Pure architectural rationale.
- Naming, ownership, or responsibility split.
- Non-code planning decision.
- Human-facing documentation quality.

Qualitative verification must still cite concrete evidence, such as reviewed files, matched RFC sections, risks checked, and why an executable test would not add signal.

If a TODO mixes code and documentation, test the code path and separately summarize documentation review.

## Completion Percentage Guidance

- `0-20%`: Design-only or placeholder; no meaningful behavior.
- `20-50%`: Prework or fallback path exists, major runtime path missing.
- `50-75%`: Main path works in memory/unit acceptance; browser/worker/edge coverage still incomplete.
- `75-90%`: Cross-boundary behavior and docs are covered; remaining gaps are narrower compatibility or automation gaps.
- `90-99%`: Stable and documented, but not all Done criteria are met.
- `100%`: Done criteria met, tests pass, docs, compatibility entries, demos, and examples are synchronized, and no listed gaps remain.

If a TODO has a stricter cap or completion rule, obey the stricter rule unless the TODO file has already narrowed that rule for a specific row.

## Hook And New Feature Check

When a new feature is added, evaluate whether it needs hooks before updating the TODO:

1. Does it have lifecycle events? Consider `<feature>.start`, `<feature>.end`, `<feature>.error`.
2. Does it need parameter or context mutation? Consider an interceptor hook.
3. Is it a critical boot/dispose/sync point? Add observer hooks when useful.
4. If hooks are added or deliberately skipped, record the decision in the RFC/design doc and TODO evidence.

## Validation Checklist

- The TODO header percentage matches the table average.
- The TODO header test status matches the latest command actually run.
- Public API changes are reflected in compatibility docs.
- Demo-facing or example-facing changes are reflected in their docs or matrices.
- Remaining gaps are explicit and not disguised as completed work.
- No broad formatting churn is introduced while updating docs.