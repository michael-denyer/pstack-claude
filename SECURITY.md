# Security

Report a vulnerability through [GitHub's private vulnerability reporting form](https://github.com/michael-denyer/pstack-claude/security/advisories/new), which is enabled on this repository. Please do not open a public issue for a vulnerability, because the issue tracker is public from the moment you press submit. A private advisory keeps the details between us until a fix is released.

The skill tree, the hooks, the vendored bun scripts under `plugins/pstack/skills/poteto-mode/scripts`, and the CI workflows are all in scope. Anything that makes an agent run a command the user did not intend, exfiltrate a secret, or reach outside the repository it was pointed at counts, as does a supply-chain weakness in how this repository pins and installs its own dependencies. Findings in Claude Code itself belong to Anthropic, and findings in the upstream project this repository syncs from belong upstream.

Only the latest release on `main` receives fixes. Plugin auto-update installs by version number, so a fix ships as a new release rather than as a patch to an older one, and there are no maintained release branches to back-port to.
