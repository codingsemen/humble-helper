# Firefox Add-ons listing

`listing.json` is the repository source of truth for the AMO listing metadata, icon, screenshots, and captions.

The Firefox publishing workflow submits extension versions with `web-ext sign`. A separate listing workflow synchronizes this file through the AMO API using current, CI-tested main tooling. Listing-only changes do not create extension versions. The preview files intentionally reuse the upload-ready assets in `store/chrome/`; the extension UI is the same in both browsers, so there is only one copy of each asset to maintain.

When the configured default locale differs from the existing AMO listing, synchronization keeps dashboard-managed translated fields and adds their old-default fallback under the new locale where needed. Existing translations and repository overrides take precedence; contact values are not replaced or cleared. AMO outgoing URL wrappers are converted back to the original URL locale map. You can explicitly manage `metadata.support_email` and `metadata.support_url` as locale maps, including a value in `default_locale`.

The sync is deliberately explicit about replacing existing AMO previews. Review changes to this file and the referenced images in a pull request before publishing.

To repair the listing without resubmitting the add-on, run **Actions -> Synchronize Firefox listing** from `main` after its CI passes. Leave the version empty for AMO's current public version, or specify an existing listed version. `pnpm run sync:amo -- --dry-run` validates the local listing offline.

AMO policy and reviewer settings, including any dashboard-only fields that are not accepted by the external metadata API, remain one-time manual setup.
