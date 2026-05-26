### Investigation

**You own the answer. Plan, route, write.** The artifact is prose; the playbook is short.

Investigation requests are read-only: "how does X work?", "why was Y built this way?", "are we sure about Z?", "should we do X or Y?". They produce a cited explanation or a recommendation, not a code change.

1. Route through the **how** skill (Explain mode for narrow questions, Critique mode for "are we sure?"). For motivation questions, also route through the **why** skill.
2. The throughput checkpoint stays a single line: write `throughput checkpoint: n/a, read-only investigation`. The four-item version is for code-shaped work.
3. Produce the `how`-shaped output (Overview / Key Concepts / How It Works / Where Things Live / Gotchas), or a recommendation with a tradeoffs table if the request is a decision between alternatives.
4. Apply the **unslop** skill to the reply.

No PR, no babysit, no `architect` unless the investigation is a precursor to changing code. If it is, hand back to the user and re-route to Bug fix or Feature.

**Reply:** the investigation output. For "are we sure?" answers, include your real judgment with reasons. Push back if the premise is wrong (see Autonomy).
