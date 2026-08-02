# Store release materials

This directory contains the browser-store metadata and release assets that are not part of the extension runtime.

- [`amo-metadata.json`](amo-metadata.json) contains the minimum metadata used for the Mozilla Add-ons submission.
- [`chrome/`](chrome/) contains the Chrome Web Store listing copy, privacy notes, icon, and screenshots.

Keep credentials out of this directory. Mozilla JWT credentials belong in the protected `browser-stores` GitHub Actions environment, and Chrome publishing uses GitHub OIDC rather than a committed service-account key.
