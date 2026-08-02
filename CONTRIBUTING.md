# Contributing

Thanks for helping improve Humble Helper.

## Issues and feature requests

- Search existing issues before opening another one.
- Include a Humble bundle URL and screenshots for visual or matching problems.
- Never attach Steam cookies, browser profiles, tokens, or other account secrets.
- Report suspected vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a public issue.
- For larger features, open an issue before investing in the implementation so the behavior can be agreed first.

## Pull requests

1. Read the [branching and change conventions](docs/BRANCHING.md), then create a focused topic branch.
2. Keep unrelated formatting or generated-file changes out of the pull request.
3. Add or update tests for parsing, matching, storage, settings, and release behavior.
4. Run:

   ```bash
   pnpm test
   pnpm run check
   pnpm run build
   ```

5. Run `pnpm run audit` when changing dependencies. GitHub also performs a scheduled weekly audit.
6. Test the unpacked build in Firefox or Chrome when the change affects browser or page behavior.
7. Explain what changed, how it was tested, and any known limitations. Apply a release-note label.

AI-assisted contributions are welcome. Please disclose substantial generated changes and review them before submission. The contributor remains responsible for the code in the pull request.

## Design principles

- Keep the interface restrained and readable; avoid floating overlays that obscure Humble content.
- Prefer cached, public metadata over repeated network requests.
- Do not collect analytics or send library data outside Steam or browser-local storage.
- Treat title matches conservatively. "Unknown" is better than a confident false match.
- Preserve behavior in both Firefox and Chrome builds.
