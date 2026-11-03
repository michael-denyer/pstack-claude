---
name: principle-encode-lessons-in-structure
description: "Apply when you catch yourself writing the same instruction a second time, or notice a recurring correction. Encode the rule as a lint, metadata flag, runtime check, or script instead of more text."
user-invocable: false
---

# Encode Lessons in Structure

Encode recurring fixes in mechanisms instead of textual instructions. Instructions are easy to miss. Lint rules, metadata flags, runtime checks, and scripts enforce the rule without the reader's cooperation.

**Pick the strongest mechanism the situation allows.** An unrepresentable state that cannot compile, then a lint or banned API that fails CI, then a canonical helper, then a runtime check. Agents copy what the surrounding code does, so a weaker guard becomes the next template.

If the lesson needs judgment and cannot be encoded, make the instruction more prominent and add an example of the failure mode.

**Corollary:** If the fix is structural, only use the structural fix. The instruction is the symptom.
