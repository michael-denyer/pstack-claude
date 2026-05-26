# Linear Tickets

## What this source contains

- Issues describing features, bugs, and their motivation
- Project docs attached to issues (often contain PRDs or specs)
- Parent/sub-issue relationships (broader initiative → specific tickets)
- Comments on issues (often contain clarifications, changes of scope, "why we're doing this" rationale)
- Labels (e.g., `compliance`, `customer-request`, `perf`) that signal the type of motivation
- Status updates that explain scope changes
- Attachments and linked GitHub PRs

Linear is often where the product/business context lives, the "we're doing this because customer X asked" or "this is for the Q3 compliance initiative" layer.

## How to search it

Use the Linear MCP available in your environment.

Good queries:

1. **Start with linked tickets.** If the seed commits or PRs reference ticket IDs (e.g., `ENG-1234`, `[BUG-567]`), fetch those first with `get_issue`. Read the full issue including comments.

2. **List related issues by keyword.** Use `list_issues` with text search for the feature name, key symbol, or business term. Try multiple phrasings.

3. **Walk the issue tree.** If you land on a sub-issue, fetch its parent. Sub-issues are usually tactical; parents often carry the "why."

4. **Read project docs.** If the issue belongs to a project, use `get_project` and check for attached docs. Project-level documents are where specs and rationale are most often captured.

5. **Check labels and milestones.** Labels often hint at category of motivation (customer-request, incident-followup, compliance). Milestones tie work to deadlines which themselves often reveal motivation.

## What good evidence looks like here

- An issue description that states the business problem: "Customer Acme needs X because of their SOC2 audit"
- A comment that records a decision: "We decided to go with approach B because approach A would require touching the billing service"
- A parent issue titled like an initiative: "Q3 Enterprise Readiness" or "Reduce Payment Failures"
- An attached PRD or spec
- Labels like `customer:acme`, `incident-followup`, `compliance`, `perf-regression`

## Common pitfalls

- **Scope drift.** The ticket the PR references may have been closed and reopened with a different scope. Read the whole history.
- **Ticket templates filled in mechanically.** Some teams require tickets to have "Why" sections but fill them with boilerplate. If the text is generic ("improve user experience"), it's probably not a real answer.
- **Stale tickets.** Old tickets often reflect a version of the plan that changed. Check dates and cross-reference with the code's ship date.
- **Closed-as-duplicate chains.** Follow the duplicate-of relationships back to the canonical ticket.
- **Private workspace content.** If you can't access an issue, note that as a gap rather than guessing.

## What to return

For each relevant ticket:
- Ticket ID and title
- The problem/motivation quoted from the description or comments (not paraphrased, the synthesizer needs the exact text to cite)
- Labels, parent issue, project
- Author, created date, closed date
- Link to the ticket if available
