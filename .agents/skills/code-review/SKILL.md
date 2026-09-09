---
name: code-review
description: "Review changes since a fixed point along three independent axes: repository standards, originating spec, and deletion-focused simplification. Runs the applicable reviews in parallel and reports them side by side. Use for branch, PR, or work-in-progress review since a commit, branch, tag, or merge-base."
---

Three-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating issue / spec?
- **Simplification**: what can be deleted or replaced while preserving Standards and Spec?

Run the applicable axes as **parallel sub-agents** so they don't pollute each other's context, then aggregate their findings without reranking across axes.

The issue tracker should have been provided to you. If `docs/agents/issue-tracker.md` is missing, tell the user to run `/setup-matt-pocock-skills`.


## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`, etc.). If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside the parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.


### 4. Spawn the applicable sub-agents in parallel

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- Load `clean-code` and apply it to changed handwritten code, with documented repository standards taking precedence.
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."


**Simplification sub-agent prompt** should include:

- The full diff command and commit list.
- Load `ponytail-review` and apply it to the diff.
- The brief: "Review only for unnecessary complexity. Report one line per finding with location, one of `delete`, `stdlib`, `native`, `yagni`, or `shrink`, what to cut, and the concrete replacement. End with the possible net line reduction. Preserve required behavior, tests, repository standards, and spec scope. If nothing can be cut, report `Lean already. Ship.`"

If the spec is missing, skip the Spec sub-agent and note this in the final report.

Present the reports under `## Standards`, `## Spec`, and `## Simplification` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings: correctness, conformance, requested behavior, and simplification remain independent concerns.

End with a one-line summary: total findings per applicable axis and the worst issue within each axis, if any. For Simplification, include the possible net line reduction instead of choosing a worst issue.

## Why three axes

A change can satisfy one concern and fail another:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that implements the issue but breaks project conventions → **Spec pass, Standards fail.**
- Correct, conforming behavior with speculative layers or hand-rolled platform behavior → **Standards and Spec pass, Simplification fail.**

Separate reports prevent one concern from masking another. Simplification proposes a smaller implementation; it never overrides Standards or Spec.
