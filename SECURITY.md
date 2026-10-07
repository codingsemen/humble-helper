# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository when it is available. If it is not enabled, open a minimal issue asking the maintainer for a private contact channel; do not publish exploit details or account data in the issue.

Never include Steam or Humble cookies, browser-profile data, store credentials, OAuth tokens, or other secrets in a report. Useful reports include the affected version, browser, reproduction steps using non-sensitive test data, impact, and a suggested mitigation if known.

## Supported versions

Security fixes are applied to the latest released version and the default development branch. Older extension packages should be upgraded before reporting a problem that is already fixed in the current version.

The dependency lockfile is audited weekly without exceptions. CI and releases also block high/critical advisories, subject only to the documented [temporary release exception](docs/SECURITY-EXCEPTIONS.md). Dependabot security updates must be enabled separately in repository settings. These automated checks supplement responsible disclosure and code review; they do not replace either.
