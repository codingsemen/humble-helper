# Humble Helper

Humble Helper is an open-source Firefox and Chrome extension for people who buy Humble Bundles and keep their games on Steam.

It watches the current Humble game-bundle catalog, highlights games and DLC already owned or wishlisted on the signed-in Steam account, and can apply a preferred donation allocation at checkout.

> This is a personal project and is not affiliated with Humble Bundle, Valve, Firefox, Mozilla, Google, or the Chrome Web Store.

## Features

- Lists current Humble game bundles in the toolbar popup with artwork, item counts, lightweight category tags, end dates, and direct links.
- Refreshes the catalog when the browser starts and once per hour while active.
- Marks newly discovered bundles in the popup and on the extension badge until the popup is opened.
- Caches the signed-in Steam library and wishlist locally, avoiding repeated account requests.
- Marks owned, wishlisted, and unresolved Steam items directly on Humble bundle pages.
- Resolves Steam games and DLC conservatively and caches title-to-app mappings.
- Applies a configurable developer / charity / Humble allocation. The default is `50 / 50 / 0`; Humble's mandatory minimum is preserved automatically.
- Produces separate Firefox and Chrome packages from the same source.

## Privacy

- Steam library and wishlist IDs stay in the background process and extension-local browser storage. Extension pages receive aggregate counts, not the ID lists.
- Steam login cookies are sent only to Steam's account endpoints. Public title-search and app-details requests omit credentials.
- Humble's public bundle catalog is cached locally.
- Steam Search receives only previously unseen bundle titles that need an app-ID match.
- No analytics, advertising, remote code, or private server is used.

Ownership and wishlist labels are inserted into Humble pages, so Humble's page scripts can observe those visible labels. The configured donation allocation is also bridged into Humble's checkout page so its own slider code can apply it. Always review the final allocation before completing a purchase; the automation deliberately stops if the expected three-recipient checkout structure is not present.

## Development

Requirements: Node.js 22 or newer and pnpm (Corepack can install the pinned version).

```bash
corepack enable
pnpm install
pnpm run audit
pnpm test
pnpm run check
pnpm run build
```

Build output:

- `artifacts/firefox/` — Firefox/AMO ZIP
- `artifacts/chrome/` — Chrome Web Store ZIP
- `dist/firefox/` and `dist/chrome/` — unpacked development builds

`pnpm run build` is the reusable release build command. It recreates both unpacked directories, validates Firefox, and packages the current version into both artifact directories. Use `pnpm run build:firefox` or `pnpm run build:chrome` when only one browser package is needed.

### Load locally

Firefox:

1. Run `pnpm run prepare:build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on** and select `dist/firefox/manifest.json`.

Chrome:

1. Run `pnpm run prepare:build`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select `dist/chrome`.

Sign in to Steam in the same browser profile, then open a Humble bundle page.

## Project provenance

The repository owner did not manually write the implementation. The project has been designed, implemented, debugged, and documented through AI coding agents under the owner's direction and testing feedback.

That disclosure is informational, not a warranty. The code should be reviewed like any other community-maintained browser extension.

## Contributing

Feature requests, bug reports, and pull requests are welcome. Use the repository's issue templates or read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a larger change. Topic branches follow the conventions in [docs/BRANCHING.md](docs/BRANCHING.md). Human-written and AI-assisted contributions are both accepted; contributors should test and disclose generated changes they have not personally reviewed.

Publishing and GitHub Actions are documented in [publish.md](publish.md).
Security reports should follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) — use, modify, and redistribute the project freely under the license terms.
