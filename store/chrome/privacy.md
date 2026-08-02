# Chrome Web Store privacy disclosure

Use these answers when completing the Chrome Web Store Privacy tab. Confirm them against the current implementation before every submission.

## Single-purpose description

Humble Helper helps users discover Humble game bundles and compare bundle items with their Steam library and wishlist, with an optional donation-split preference.

## Data handling

- The extension reads bundle content on Humble Bundle pages to identify bundle items and donation controls.
- It requests the user's Steam account pages and dynamic store data only when the user asks for a refresh or bundle analysis.
- Signed-in Steam requests use the browser's existing Steam session only at Steam's HTTPS endpoints; the extension does not read, store, or send Steam passwords or cookie values to any other party.
- Humble page content and Steam responses are processed only to provide bundle matching, ownership/wishlist marks, and the saved donation allocation.
- Steam library and wishlist app IDs are kept in extension-local browser storage and are not sent to a private server.
- Steam title searches receive only bundle titles that need matching; those searches omit Steam credentials.
- The extension does not sell, transfer, or use browsing data for advertising, analytics, creditworthiness, or unrelated personalization.
- The extension does not use remote code, an analytics SDK, advertising SDK, or a private backend.

This is a Limited Use disclosure: information received from Steam and Humble is used only for the extension's user-facing bundle comparison and donation-allocation features.

## Permissions rationale

- `storage`: save settings, the local bundle catalog, and the local Steam snapshot.
- `alarms`: refresh cached Steam and Humble data periodically.
- Humble Bundle host access: read bundle pages and apply visible marks or donation preferences.
- Steam host access: read the account snapshot and perform public title matching.

Do not describe this file as a substitute for a hosted legal privacy policy if the Chrome Web Store requires a public policy URL for the listing.
