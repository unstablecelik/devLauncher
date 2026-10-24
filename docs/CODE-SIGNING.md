# devLauncher Code Signing Guide

Signing requires a certificate **purchased in your own name** — devLauncher's build
system is prepared so that the only missing piece is your credential. Everything below
is env-var driven; no secrets are stored in the repo.

## Why sign?

| Platform | Without a cert | With a cert |
|----------|----------------|-------------|
| Windows  | SmartScreen "Unknown publisher" warning on every download | Installers run with a trusted publisher badge (EV clears SmartScreen quickly) |
| macOS    | Gatekeeper blocks ("damaged/unverified") for anyone not right-click-opening | Notarized app opens normally |
| Linux    | Nothing needed (AppImage has no signing ecosystem yet) | — |

## Windows (Authenticode)

1. Buy a code-signing certificate. Realistic 2026 options:
   - **Azure Trusted Signing** (~$10/month, identity verified once in Azure) — recommended
     if you have (or can make) a free Azure account; signing happens in the cloud.
   - **Certum "Open Source Code Signing"** (cheap for open-source devs, cloud/card signing).
   - **SSL.com / Sectigo / GlobalSign OV** (~$100–400/yr, standard token or cloud).
   EV certs cost the most but SmartScreen reputation comes fastest.
2. Export PFX (or receive one) → never commit it.
3. Run the signed build:

```bash
export CSC_LINK=/absolute/path/to/certificate.pfx   # or a base64 PFK string
export CSC_KEY_PASSWORD='the pfx password'
npm run dist
```

electron-builder picks up `CSC_LINK`/`CSC_KEY_PASSWORD` automatically for the `win`
target. The build config (package.json `build.win.signtoolOptions`) already pins
SHA-256 with DigiCert's RFC 3161 timestamp server.

Verify a built exe:

```powershell
signtool verify /pa /v dist\devLauncher-Setup-0.13.0.exe
```

For **Azure Trusted Signing**, electron-builder 25.1+ also supports
`win.signtoolOptions.signingIdentity` (your Trusted Signing account id) plus
`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` when configured —
or you can post-sign every dist artifact with `signtool sign /td sha256 /fd sha256 ...`
from a small script; the timestamp settings here match that flow too.

## macOS (codesign + notarization)

Prereq: **Apple Developer Program** membership ($99/yr) → create an **App-specific
password** at appleid.apple.com (not your Apple password).

electron-builder config already sets: `hardenedRuntime`, `gatekeeperAssess: false`,
the hardened entitlements file (`build/entitlements.mac.plist` — JVM/LWJGL need
JIT + unsigned native libs), and `notarize: true` (notarytool).

```bash
export CSC_LINK=/absolute/path/to/DeveloperIDApplication.p12
export CSC_KEY_PASSWORD='the p12 password'
export APPLE_ID='your apple id email'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='XXXXXXXXXX'
npm run dist
```

Verify: `spctl -a -vv dist/mac-arm64/devLauncher.app` should print "accepted".
Notarization logs: `xcrun notarytool log <submission-id> --keychain-profile ...`.

## CI (GitHub Actions)

Store the PFX/P12 in repo **Secrets** (`CSC_LINK` base64, `CSC_KEY_PASSWORD`,
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and export them in the
release workflow before `npm run dist`. Without the env vars, builds stay unsigned —
nothing breaks, you just keep the SmartScreen/Gatekeeper warnings.

## One-time repo hygiene

- Never commit `*.pfx`, `*.p12`, or passwords.
- After switching to signed builds, force users of the portable/zip artifacts to
  redownload manually (electron-updater refuses cross-level target changes).
