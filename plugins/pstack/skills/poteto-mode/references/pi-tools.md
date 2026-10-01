# Pi tool mapping for pstack

## Model names

Skills name models by the Claude aliases in their Models sections. On Pi, pass the alias as the `agent` tool's `model`; the pstack extension resolves it to a Pi model:

- `opus`: `anthropic/claude-opus-5.5`
- `fable`: `anthropic/claude-fable-5.1`
- `sonnet`: `anthropic/claude-sonnet-5.5`
- `haiku`: `anthropic/claude-haiku-4.5`

A `pi models: opus=<provider/id>, sonnet=<provider/id>` line in the Pi override sheet points each alias it names at another Pi model, for a machine without Anthropic access. The `agent` tool also takes a full `provider/id`, passed through unchanged, and `inherit-parent`, `auto`, or no `model` runs the child on the parent's current model. Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`) stay diverse only while their aliases resolve to distinct models. If one model family is all you can reach, vary the reasoning effort and note in the verdict that diversity was reduced.

`/setup-pstack` writes the configured model list. On Pi, keep the aliases and remap them with `pi models:`.

## Per-skill notes

| Skill | On Pi |
|-------|-------|
