# Firefox Add-ons listing

`listing.json` is the repository source of truth for the AMO listing metadata, icon, screenshots, and captions.

The Firefox publishing workflow first submits the version with `web-ext sign`, then synchronizes this file through the AMO API. The preview files intentionally reuse the upload-ready assets in `store/chrome/`; the extension UI is the same in both browsers, so there is only one copy of each asset to maintain.

When the configured default locale differs from the existing AMO listing, synchronization keeps dashboard-managed translated fields and adds their old-default fallback under the new locale where needed. Existing translations and repository overrides take precedence; contact values are not replaced or cleared. AMO outgoing URL wrappers are converted back to the original URL locale map. You can explicitly manage `metadata.support_email` and `metadata.support_url` as locale maps, including a value in `default_locale`.

The sync is deliberately explicit about replacing existing AMO previews. Review changes to this file and the referenced images in a pull request before publishing.

AMO policy and reviewer settings, including any dashboard-only fields that are not accepted by the external metadata API, remain one-time manual setup.
