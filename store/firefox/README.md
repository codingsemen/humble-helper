# Firefox Add-ons listing

`listing.json` is the repository source of truth for the AMO listing metadata, icon, screenshots, and captions.

The Firefox publishing workflow first submits the version with `web-ext sign`, then synchronizes this file through the AMO API. The preview files intentionally reuse the upload-ready assets in `store/chrome/`; the extension UI is the same in both browsers, so there is only one copy of each asset to maintain.

The sync is deliberately explicit about replacing existing AMO previews. Review changes to this file and the referenced images in a pull request before publishing.

AMO policy and reviewer settings, including any dashboard-only fields that are not accepted by the external metadata API, remain one-time manual setup.
