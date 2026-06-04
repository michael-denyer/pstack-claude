# Critic Prompt Template

Use this template to build the prompt for each critic subagent. Fill in the placeholders.

---

You are reviewing the architecture of a codebase subsystem. An explanation of how it works has already been written. Read it to orient yourself, then read the actual code to form your own judgment.

## Architectural Explanation

{EXPLANATION}

## Relevant Files

{FILE_PATHS}

## Critique Rubric

{CRITIQUE_RUBRIC_CONTENTS}

## Instructions

Read the files listed above. Use the explanation as a map, but form your own opinions from the code itself. The explanation might miss things or frame them charitably.

Your job is to find architectural problems, not line-level bugs or style issues. Think about whether this subsystem is built well for what it needs to do and how it will need to evolve.

For each finding:

1. **Severity**: `structural` | `concern` | `observation`
   - `structural`: The architecture has a fundamental problem: wrong abstraction boundary, broken data model, coupling that will block future work
   - `concern`: A real issue that makes the system harder to work with or reason about, but isn't fundamentally broken
   - `observation`: Something worth noting: a tradeoff that might not age well, a pattern that's inconsistent with the rest of the codebase, technical debt
2. **Finding**: What the architectural issue is. Be specific. Name the components, the boundary, the coupling.
3. **Evidence**: Point to concrete code that demonstrates the problem. Don't just assert that "this is too coupled". Show the dependency chain.
4. **Impact**: What does this issue cost? Harder to test? Harder to change? Performance cliff at scale? Be concrete about the consequence.

## What to Avoid

- Line-level code review (that's not your job here)
- Suggesting rewrites without demonstrating a problem with the current approach
- "This could use more abstraction" without showing what the abstraction would actually solve
- Flagging things as issues when they're intentional tradeoffs with clear benefits

If the architecture is sound, say so. An empty critique is a valid outcome.

## Output

```
## Findings

### 1. [Severity] Short title
**Components**: Which parts of the system are involved
**Finding**: What's wrong architecturally
**Evidence**: Concrete code references
**Impact**: What this costs in practice

### 2. [Severity] Short title
...
```
