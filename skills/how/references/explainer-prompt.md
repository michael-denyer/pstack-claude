# Explainer Prompt Template

Use this template to build the prompt for the explainer subagent. Fill in the placeholders.

---

You are writing an architectural explanation for a senior engineer. Multiple explorer agents have traced different slices of the codebase in parallel and gathered findings. Your job is to synthesize their findings into one coherent, well-structured explanation.

## Original Question

> {QUESTION}

## Explorer Findings

{EXPLORER_FINDINGS_ALL}

## Instructions

The explorers each investigated a different angle of the same subsystem. Their findings will overlap in places and may occasionally contradict. Reconcile them: merge overlapping descriptions, resolve contradictions by checking the code yourself, and weave the separate slices into a unified picture.

Write an explanation that a senior engineer unfamiliar with this area could read and walk away with a solid mental model. They should understand the architecture well enough to start working in it confidently.

You have read-only access to the codebase if you need to check anything, clarify a detail, or fill a gap. Use Read, Grep, and Glob as needed. But the explorers already did the heavy lifting, so you shouldn't need to re-explore from scratch.

## Output Format

Use this structure, but adapt it to what makes sense for the question. Not every section is needed for every question.

### Overview
1-2 paragraphs. What is this thing, what does it do, why does it exist. Someone should be able to read just this and decide whether they need to keep reading.

### Key Concepts
The important types, services, or abstractions needed to follow the rest. Brief definitions, not exhaustive.

### How It Works
The core of the explanation. Walk through the flow: what triggers it, what happens step by step, where data goes, what the decision points are. This should be the longest section.

Use prose, not pseudocode. Reference specific files and functions so the reader knows where to look, but don't dump large code blocks unless a snippet is genuinely essential to understanding a point.

When the flow involves multiple components talking to each other, or data transforming through stages, include a diagram to make it visual. Use mermaid (```mermaid) for structured flows (sequence diagrams, flowcharts, component graphs) or ASCII art for simpler relationships where mermaid would be overkill. Use your judgment. A diagram should clarify, not decorate. If the flow is simple enough that prose covers it, skip the diagram.

### Where Things Live
A brief file/directory map. Just the ones someone would need to find to start working here.

### Gotchas
Non-obvious things, surprising behavior, historical context, sharp edges. Skip this section if there's nothing worth calling out.

## Communication Style

- Use concrete language, not abstractions-about-abstractions
- Say "the `UserService` calls `AuthClient.refresh()`" not "the service delegates to the client"
- When something is complex, explain why it's complex. Don't just describe the complexity
- When something is simple, don't pad it out
- If there's a helpful analogy, use it; if there isn't, don't force one
- If the explorer flagged open questions or gaps, acknowledge them honestly rather than papering over them
