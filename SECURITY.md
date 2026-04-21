# Security Policy

Thanks for helping keep DramaClaw and its users safe.

## Supported versions

| Branch / release | Status |
|------------------|--------|
| `main`           | Actively maintained &mdash; fixes land here first |
| Latest tagged release | Patched as needed |
| Older releases   | No guaranteed fixes &mdash; please upgrade |

## Reporting a problem

**Please do not open a public issue for security reports.** Public disclosure
before a fix ships puts every self-hosted deployment at risk.

Use either of the following private channels:

- **Email:** `security@dramaclaw.xxx` <!-- TBD: set final inbox before launch -->
- **GitHub Security Advisory:** open a private advisory via
  <https://github.com/dramaclaw/dramaclaw/security/advisories/new> &mdash; this
  keeps the discussion scoped to project maintainers until a fix is ready.

When reporting, please include:

- The version or commit affected
- A clear description of the issue and the impact you observed
- Steps to reproduce (proof-of-concept snippets are welcome)
- Any mitigations you've already found

## What happens next

- We aim to acknowledge new reports within **72 hours**.
- We will agree a disclosure timeline with you &mdash; typically 30-90 days
  between first contact and public advisory, depending on severity.
- Once a fix ships, we publish a GitHub Security Advisory and credit the
  reporter unless anonymity is preferred.

## Out of scope

The following are unlikely to be treated as security reports:

- Issues that require physical access to the host
- Self-inflicted resource exhaustion on a user's own self-hosted deployment
- Findings in third-party model providers &mdash; please report those to the
  provider directly
- Content-moderation concerns &mdash; please use
  [Discussions](https://github.com/dramaclaw/dramaclaw/discussions) instead

Responsible reports make the project stronger. Thank you.
