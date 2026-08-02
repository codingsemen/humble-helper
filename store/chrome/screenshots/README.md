# Chrome Web Store screenshots

Store screenshots must be actual captures of the current extension at one of these exact sizes:

- 1280 × 800 PNG (preferred), or
- 640 × 400 PNG.

Use RGB PNGs with no alpha channel. Keep the page full bleed and remove personal account data before committing.

Planned files:

- `01-bundle-discovery.png`
- `02-steam-overlap.png`
- `03-donation-settings.png`
- `04-donation-allocation.png`
- `05-localized-humble.png` (optional; add after capturing a localized Humble page)

The numbered files are the upload-ready assets. The original captures may remain in this folder as source material, but upload only the numbered files.

Do not add empty placeholders. Capture each file only after the corresponding use case is visible and verified in Chrome.

## Capture an exact 1280 × 800 image in Chrome

Chrome DevTools can capture the viewport at the required dimensions without relying on the size of the Windows desktop:

1. Open the use-case tab and press `F12`.
2. Press `Ctrl+Shift+M` to enable the device toolbar.
3. Select **Responsive**, set the viewport to `1280` × `800`, and set the device pixel ratio to `1` when that control is visible. Keep page zoom at 100%.
4. Press `Ctrl+Shift+P`, search for **Capture screenshot**, and choose the plain **Capture screenshot** command (not full-size).
5. Rename the downloaded PNG to the matching filename above.

Chrome accepts a 24-bit PNG, so JPEG conversion is not required. If a JPEG is specifically needed, open the PNG in Paint and use **Save as → JPEG picture**; verify that the dimensions remain 1280 × 800.

Before saving, scroll or choose the tab so the extension mark, wishlist/owned state, or donation allocation is visible, and remove or avoid account names, email addresses, Steam IDs, and other private data.
