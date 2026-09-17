---
name: principle-test-behavior-not-implementation
description: "Apply when you write, change, or keep a test. Identify a relevant defect and check that the test detects it. Assert the required result or observable effect, including absence when the contract requires it."
user-invocable: false
---

# Test behavior, not implementation

Before keeping a test, name a relevant defect and determine whether the complete test arrangement detects it. Where practical, introduce that defect temporarily and observe the failure. Exercise the subject through its public interface and check the required result or effect.

- A missing-result experiment helps when the contract requires a result. `toBeDefined` detects a missing result, but accepts the wrong one. Strengthen it to check the particular result when correctness requires one.
- Keep absence assertions when absence is required. For a denied operation that must send no email, exercise the denial and check the outbox is empty. Temporarily make the denied path send an email and confirm the test fails. An assertion on absence does not require a positive case in the same test.
- Keep fixed-value checks when the value is an explicit user-facing contract, such as a promised default or instruction. Name that contract and the defect a changed value would cause. Avoid freezing incidental constants or prompt wording with no such contract.
- Keep comparisons between results when disagreement exposes a real defect. An expected result computed through the same faulty path as the actual result can confirm itself. Use an independent expectation or a relation that the identified defect actually violates.
- Assess shared setup and the test body together. Calling the subject in `beforeEach` is valid; asserting only untouched fixture data is not.

Reject tests that exercise nothing relevant, assert nothing meaningful, or only show that a substitute was called without checking the required effect. Check its payload or resulting state when that establishes the contract. An assertion's syntax alone cannot tell you whether it detects a defect.
