---
name: easy-change
description: Make requested code changes easier through bounded, behavior-preserving preparatory refactoring. Use during feature work, bug fixes, or behavior changes when structure makes the change scattered, risky, or disproportionately difficult, signaled by lint suppression, unrelated imports or dependencies, duplicated test setup, awkward test seams, or local workarounds.
---

# Make the change easy

For each desired change, make the change easy (warning: this may be hard), then make the easy change.

Before editing, inspect the requested behavior in its surrounding structure. Choose one path:

1. **Proceed directly** when the requested change is already small and localized.
2. **Refactor, then proceed** when a bounded, behavior-preserving internal refactoring makes the change dramatically simpler.
3. **Stop and notify** when that refactoring introduces a material scope, ownership, compatibility, or verification decision.

## Refactor, then proceed

Act autonomously when the preparatory refactoring:

- is bounded to the requested behavior;
- has an immediate use and a clear stopping condition;
- preserves observable behavior;
- stays inside the affected module or package;
- is straightforward to verify and review;
- is smaller and safer than making the behavioral change directly;
- leaves public APIs, schemas, protocols, persistence, and deployment contracts unchanged.

Examples:

- route duplicated policy through one function, after which one function implements the request;
- isolate a side effect, after which the behavior can be tested and changed independently;
- split mixed responsibilities, after which one responsibility changes without disturbing the others;
- replace scattered representation knowledge with one value or operation, after which callers stop duplicating it.

Separate structure from behavior conceptually and, where the repository workflow permits, in reviewable commits:

1. Establish focused verification of current observable behavior.
2. Apply the smallest behavior-preserving refactoring that reaches the stopping condition.
3. Verify behavior is unchanged.
4. Implement the now-easy requested change.
5. Verify the new observable behavior.

Stop refactoring as soon as the original change is small, localized, and obvious. Report the preparatory refactoring and behavioral change separately.

## Stop and notify

Stop before editing when the preparatory refactoring:

- crosses module, package, service, or team-ownership boundaries;
- changes a public API, schema, protocol, persistence model, or compatibility contract;
- requires a broad caller migration or substantially enlarges the diff;
- conflicts with documented architecture;
- introduces a consequential abstraction or dependency with plausible alternatives;
- may interfere with concurrent work;
- cannot be independently verified as behavior-preserving;
- is closer to redesign than bounded preparation.

Finish enough investigation to make the decision concrete, then notify the user with:

```text
Structural obstacle: <what makes the requested change difficult>
Preparatory refactoring: <the smallest behavior-preserving structural change>
Resulting easy change: <how the original request becomes localized or obvious>
Scope and risk: <the material boundary, verification gap, or expanded scope>
Recommendation: <refactor first or implement directly>
```

Wait for the user's decision on the material scope.

## Restraint

Prefer direct implementation when the improvement is marginal, the requested change is already localized, or the proposed refactoring is broader than the problem. Unrelated cleanup, speculative extension points, aesthetic redesign, and broad rewrites do not qualify.
