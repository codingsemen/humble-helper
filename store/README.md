# Store release materials

This directory contains the browser-store metadata and release assets that are not part of the extension runtime.

- [`firefox/listing.json`](firefox/listing.json) is the source of truth for the AMO listing metadata, icon, screenshots, and captions. The Firefox publishing workflow synchronizes it after submitting each version.
- [`chrome/`](chrome/) contains the Chrome Web Store listing copy, privacy notes, icon, and screenshots.

Keep credentials out of this directory. Mozilla JWT credentials belong in the protected `browser-stores` GitHub Actions environment, and Chrome publishing uses GitHub OIDC rather than a committed service-account key.
