# Temporary release audit exception

Approved by the maintainer on October 7, 2026; expires **November 6, 2026 at 00:00 UTC**.

| Field | Accepted scope |
| --- | --- |
| Advisory | [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) |
| Package/version | `node-forge` `1.4.0` |
| Severity | High only |
| Dependency path | `.>web-ext>@devicefarmer/adbkit>node-forge` |
| Finding flags | Development dependency; not optional or bundled |

The advisory concerns RSA PKCS#1 v1.5 signature verification. Its reachable caller here is adbkit's Android TCPUSB device bridge, used by `web-ext run` on Android. Our lint/build/sign jobs do not use that bridge. Packaging copies an explicit extension file allowlist and excludes `node_modules`, so this tooling dependency is not shipped to users. This is a narrow exposure assessment, not a claim that the vulnerable library is safe in general.

No patched node-forge release was available when this exception was approved. Upstream tracking: [issue #1149](https://github.com/digitalbazaar/forge/issues/1149), [proposed fix #1152](https://github.com/digitalbazaar/forge/pull/1152). Relevant callers: [adbkit authentication](https://github.com/DeviceFarmer/adbkit/blob/v3.3.9/src/adb/auth.ts), [TCPUSB bridge](https://github.com/DeviceFarmer/adbkit/blob/v3.3.9/src/adb/tcpusb/socket.ts), [web-ext Android runner selection](https://github.com/mozilla/web-ext/blob/10.7.0/src/extension-runners/index.js).

`pnpm run audit:release` runs a full JSON dependency audit and applies this policy in `scripts/release-audit.mjs`. It rejects malformed/incomplete reports, audit tool failures, different package versions or dependency paths, every other high/critical advisory, and this exact finding on or after expiry. A clean audit continues to pass after expiry.

The weekly security workflow and `pnpm run audit` remain unfiltered and continue reporting this finding. Do not add a global pnpm advisory ignore. Remove this exception once a patched dependency is available, refresh the lockfile, and confirm both audit commands pass. Extending expiry requires a fresh maintainer review; it does not renew automatically.
