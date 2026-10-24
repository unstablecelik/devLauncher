# devLauncher v0.13 Feature Report (Phases 1–4)

Summary of the feature roadmap work: Phase 1 (Baseline Trust), Phase 2 (Signature
Features), Phase 3 (Remote/Passthrough) and Phase 4 (Community/Extras). All solutions
verified with `node --check`, 16 test suites and real-network probes.

## 1) What was built

| # | Feature | File(s) | Status |
|---|---------|---------|--------|
| 1 | **Self-Update** | `src/services/updaterService.js` + `package.json` (`publish` block) | ✅ 10 tests |
| 2 | **Import Wizard** (Prism/MultiMC/vanilla) | `src/services/importService.js` + Dashboard button + modal | ✅ 32 tests |
| 3 | **Account Hub** (multi MS + offline, safeStorage-encrypted) | `src/services/accountService.js` | ✅ 32 tests |
| 4 | **Skin Manager** (Mojang profile API + isometric head) | `src/services/skinService.js` + renderer `drawIsoHead` | ✅ 12 tests |
| 5 | **Time Machine** (mod history + undo) | `objectStore.js` + `instanceLedger.js` + modal | ✅ 32 tests |
| 6 | **Mod Doctor** (jar health check) | `modDoctor.js` + `malware-signatures.json` + modal | ✅ 20 tests |
| 7 | **FetchPool + Prefetch** (zero-cold-start) | `fetchPool.js` + `prefetchService.js` + bar chip | ✅ 13+21 tests |
| 8 | **TTFP Benchmark** | `benchmarkService.js` + Dashboard summary line | ✅ 14 tests |
| 9 | **Remote Play** — Sunshine detect + apps.json entry + Moonlight PIN pairing + `--launch-instance` auto-start | `remotePlayService.js` + modal | ✅ 20 tests |
| 10 | **Mod Update Checker + Update All** — sha1 → Modrinth `version_file` → newer build → hash-verified in-place update (ledger txn) | `updateChecker.js` | ✅ part of faz4 suite |
| 11 | **Share Code** — `DL13-…` portable instance descriptor, import creates instance + installs every Modrinth mod | `shareCode.js` + modal | ✅ |
| 12 | **1-Click Server** — runnable server folder (vanilla piston jar / Fabric launcher jar), mods copied, eula + start scripts | `serverExporter.js` + modal | ✅ |
| 13 | **World Preview** — spawn-chunk heightmap read straight from `.mca` (minimal NBT walker) + level.dat stats; stylized color canvas | `worldPreview.js` + modal | ✅ 35 tests (crafted region round-trip) |
| 14 | **LAN QR + IP list** — after P2P host success, QR of the connect address + all local IPv4s for same-Wi-Fi play | renderer + `get-lan-info` | ✅ |
| 15 | **Interface Font selector** — OS-optimized lists (Win/macOS/Linux) + custom CSS stack, persisted via config | renderer + settings modal | ✅ |
| 16 | **New theme (Rosé Pine)** + custom-theme persistence & About section | `themeStore.js`, settings modal | ✅ |
| 17 | **Playtime** per instance (shown on instance cards) | main.js `recordPlaytime` | ✅ |
| 18 | **Diagnostics Zip** — redacted config, logs, crash reports, instance metas, benchmark & ledger files | `export-diagnostics` IPC + About button | ✅ |
| 19 | **First-Run Wizard** — username/memory → import scan → done | renderer + modal | ✅ |
| 20 | **FPS Rocket removed** (superseded by Performance Pack) | button + IPC deleted | ✅ |
| 21 | **Code-Signing infrastructure (Phase 5)** — SHA-256 + RFC-3161 timestamp pinned for the Win target, macOS hardened runtime + entitlements + `notarize: true` (notarytool), env-driven (no secrets in repo) | `package.json build.*`, `build/entitlements.mac.plist`, `docs/CODE-SIGNING.md` | ✅ config-level (your cert still required — see docs) |
| 22 | **i18n table (EN/TR)** — 61-key dictionaries, partial UI coverage via data-i18n/id/label-for selectors, Settings language switch, persisted `language` config | `src/i18n/{en,tr}.json` + renderer `applyLanguage` | ✅ parity-tested |
| 23 | **Prefetch `assetByteCap` user setting** — Settings input (MB, 0 = unlimited, clamp 0–2048, default 400) wired into both prefetch entry points | `prefetchService.assetByteCapFromMB` + Settings | ✅ 24 tests (phase5 suite) |
| 24 | **A/B verdict on Dashboard** — with vs without prefetch averages compared once both have ≥3 recordings; prints the delta + percentage honestly | renderer `refreshBenchmarkLine` | ✅ |
| 25 | **Sunshine credential variants hardened** — `auth_user/auth_pass` extracted as well; graceful web-UI fallback already present | `remotePlayService.credsFromState` | ✅ |

| 21 | **Code-Signing infra (Phase 5)** — SHA-256 + RFC-3161 timestamp pinned for Win; macOS hardened runtime + entitlements + `notarize: true` (notarytool); env-driven, no secrets in repo | `package.json build.*`, `build/entitlements.mac.plist`, `docs/CODE-SIGNING.md` | ✅ config-level (your cert still required — see docs) |
| 22 | **i18n table (EN/TR)** — 61-key dictionaries, partial UI coverage (data-i18n / id / label-for selectors), Settings language switch, persisted `language` config | `src/i18n/{en,tr}.json` + renderer `applyLanguage` | ✅ parity-tested |
| 23 | **Prefetch `assetByteCap` setting** — Settings input (MB; 0 = unlimited; clamp 0–2048; default 400) wired into both prefetch entry points | `prefetchService.assetByteCapFromMB` + Settings | ✅ phase5 suite |
| 24 | **A/B verdict on Dashboard** — with vs without prefetch averages compared once both have ≥3 recordings; prints delta + % honestly | renderer `refreshBenchmarkLine` | ✅ |
| 25 | **Sunshine credential variants hardened** — `auth_user/auth_pass` also parsed; graceful web-UI fallback already present | `remotePlayService.credsFromState` | ✅ |

**Tests:** 17 suites, **305 tests, 0 failures** — `/tmp/opencode/devlauncher-tests/*.test.js`
(Real-network probe: Mojang manifest 1.21.1 resolved, asset index + 2 assets downloaded.)

## 2) UI usage

- **Updates**: silent check at startup; download progress `⬇️ v… %` in the bottom bar,
  then `⬆️ Install vX & Restart` badge for 1-click restart.
- **Import**: Dashboard → "🔄 Import from other launchers" (saves, mods, configs,
  resourcepacks, shaderpacks, options.txt, instance-local version profiles).
- **Accounts**: bottom bar chip → "Account & Identity". MS logins are encrypted with
  `safeStorage` (OS keychain), fallback plaintext with a visible warning. Offline
  accounts get Mojang-rule UUID `md5("OfflinePlayer:"+name)` v3.
- **Skin**: with an MS account — head render + "🎨 Change Skin" uploads to the clean
  Mojang API. Offline accounts keep a custom .png path.
- **Time Machine**: mods manager → "⏱ Mod Time Machine". Install/update/remove/toggle
  (plus bulk perf-pack and mod-update transactions) all append to `instanceLedger.jsonl`
  with sha1 object backups in `~/.devlauncher/objects`. One-click "↩ Undo" per row.
- **Mod updates**: mods manager → "⬆ Check Mod Updates" → hash-of-jar lookup on Modrinth;
  "⬆ Update All" replaces jars in place (old jar removed + ledger record) after sha1 check.
- **Share Code**: instances → "🔗 Share Code". Generate for the active instance; the
  receiver pastes → instance created → every Modrinth mod downloaded + verified.
- **1-Click Server**: instances → "🖧 1-Click Server" → runnable server folder with mods,
  `server.properties`, eula.txt and start scripts; opens the folder when ready.
- **World Preview**: worlds tab → "🗺 Preview" per world card → stylized spawn heightmap
  (region file parsed in-process) + name/version/gamemode/spawn from level.dat.
- **Remote Play**: dashboard → "🖥 Remote Play". Detect Sunshine, add a devLauncher app
  entry, pair the Moonlight PIN or open the web UI as fallback.
- **Fonts/Themes/Appearance**: Settings → Interface Font (per OS list / custom stack);
  Themes modal → 11 presets incl. Rosé Pine, plus a persisted custom theme.
- **About devLauncher**: Settings bottom block — version, Electron/Node/platform,
  GitHub / Instagram / "Check for Updates" / Diagnostics Zip.
- **First run**: welcome wizard (username + RAM → import scan → tips).

## 3) Honest notes / limits

0. **Remote Play (v1) never streams video**; devLauncher only (a) detects Sunshine,
   (b) merges a `devLauncher --launch-instance=<id>` entry into apps.json (with a
   `.devlauncher-backup` first), (c) POSTs the PIN to localhost:47990 using credentials
   from `sunshine_state.json`; if credentials are unreadable it points to the web UI.
   Sunshine state-file field names vary between versions — a real-Sunshine pairing test
   is still pending. `--launch-instance` matters only in packaged mode (`APPIMAGE` env is
   preferred when execPath lives inside the mount).
1. **Self-update targets AppImage/NSIS/DMG only**; zip/portable builds update manually.
   `latest*.yml` + `*.blockmap` files are produced by `npm run dist` and must be attached
   to the GitHub release for electron-updater to see it.
2. **Perf pack / mod updates / share imports** all close the loop with Time Machine
   transactions (`perfpack-*`, `modupdate-*`, `sharecode-*`).
3. **Mod Doctor is not an antivirus**: suspicion scores are heuristic; primary defense is
   sha1 verification of every Modrinth download. `malware-signatures.json` is an
   intentionally empty list — no invented "virus database".
4. **Prefetch asset layout** assumes modern `assets/objects/<h2>/<sha1>`; MCLC re-checks
   each file anyway, so a layout drift only costs re-downloads. Impact measured by TTFP.
5. **Benchmark V1** is marker-based (`Sound engine started` / `Backend library: LWJGL`).
   Crashes before the menu record `failed` — no invented numbers. FIFO of 200 records.
6. **World Preview** is a relative-height, 1.14+ spawn-chunk preview (stylized, not
   biome-accurate). Legacy chunks fall back with an honest message.
7. **1-Click Server** supports vanilla + Fabric; Forge/NeoForge/Quilt ask for the official
   installer instead of faking a server.
8. `objectStore.gc()` is still not wired — the store grows on purpose; a GC pass must keep
   ledger references alive.
9. **Discord RPC**: works out of the box with the bundled Application ID while the Discord
   desktop app is running; a custom client ID can be set in Settings. On Linux, sandboxed
   (Flatpak/Snap) Discord builds may not expose the IPC socket — known limitation.

## 4) v0.13 packaging steps (user)

1. **GPG**: `cd dist && gpg --detach-sign --armor SHA256SUMS && gpg --verify SHA256SUMS.asc SHA256SUMS`
   (the previous SHA256SUMS.asc contained a public key block — it is invalid; overwrite it).
2. `git add -A && git commit -m "v0.13: phases 1-4" && git push -u origin main`
3. `npm run dist` → attach **`latest*.yml` + `*.blockmap`** files to the release
   (electron-updater reads them; `latest-linux.yml`, `latest.yml` for Windows, `latest-mac.yml`).
4. `gh release create v0.13.0 dist/* --title "v0.13.0" --notes-file RELEASE-NOTES.md`

## 5) Remaining roadmap

- Windows/macOS code signing: fully prepared — purchase your own certificate
  (Azure Trusted Signing ~$10/mo or Certum/SSL.com OV) and follow `docs/CODE-SIGNING.md`;
  macOS notarization additionally needs the Apple Developer Program ($99/yr).
- Real-Sunshine PIN pairing soak test (credential field names vary by version;
  five variants covered + web UI fallback already present).
- i18n is a partial table (61 keys: nav, main buttons, settings labels); extend
  `src/i18n/*.json` + add `data-i18n`/id entries — the framework is in place.
- Package-manager builds (AUR/portage/nix/xbps) — deliberately deferred.
- Auto A/B benchmark *runner* (launching the game twice without the user) is not
  possible safely; the verdict engine compares real recordings instead.

_Prepared note: every file path passes `sanitizeInstanceId` / `sanitizeModFilename` /
`resolveSafePath` checks; test suites include traversal (`..`) examples._
