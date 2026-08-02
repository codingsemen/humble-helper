# Chrome Web Store release pack

This folder is the source of truth for the Chrome Web Store listing assets and copy.

## Required upload assets

- `icon-128.png` — 128 × 128 store icon.
- `screenshots/*.png` — full-bleed PNG screenshots at exactly 1280 × 800 (preferred) or 640 × 400.
- `listing.md` — title, summary, detailed description, category, and screenshot captions.
- `privacy.md` — the data-use answers and privacy disclosure to use in the Store listing.

Chrome requires at least one screenshot and allows up to five. Screenshots must show the current user experience, contain no account identifiers or private data, and must not be fabricated or materially edited to show functionality the extension does not provide.

## Capture checklist

1. Load the current packaged extension in Chrome.
2. Open a real Humble game-bundle page, including a localized host when available.
3. Confirm the Steam marks, bundle summary, and donation settings are visible before capturing.
4. Capture each use case at 1280 × 800.
5. Verify every PNG is RGB/RGBA-free (no alpha), exactly 1280 × 800, and free of personal data.
6. Record the screenshot caption and the extension version in `listing.md`.

Do not commit Chrome Web Store access tokens, Google service-account JSON, cookies, Steam account data, or screenshots containing private account information.
