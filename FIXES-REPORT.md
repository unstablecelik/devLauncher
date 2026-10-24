# devLauncher — Audit & Fix Report

**Date:** Oct 17, 2026 · **Scope:** all root files + `src/services/*` + `src/utils/*`
**Outcome:** 36 issues found and fixed · 50 unit tests + real-network probes written, all passing · no syntax errors left.

> Internal work log — optional to commit.

---

## 1) Broken features (dead code revived)

| # | Problem | Fix | Verification |
|---|---------|-----|--------------|
| 1 | Discord RPC had no settings input — `#discord-client-id` references pointed nowhere, settings save / P2P / Java selection were broken | input added to the settings modal | 69/69 renderer id ↔ html id matches |
| 2 | FPS Rocket button never worked — `instanceManagerList` was undefined in the renderer | variable defined; filled by the `instances-list` handler | code flow + syntax (feature later superseded and removed in v0.13) |
| 3 | Screenshot zip export was dead — no `export-screenshots-zip` IPC handler | save-dialog + `ScreenshotManager.exportScreenshotsToZip` wired in main.js | handler present, service tested |
| 4 | Manual crash analysis existed nowhere | "🔍 Analyze Last Crash" button on the Instances tab; `crash-analysis-result` listener reuses the crash modal | every autoFix type in `crash-rules.json` is actionable (disable_mod / increase_ram / open_mods_folder / inspect_logs / open_settings / info_only) |
| 5 | P2P tunnel dying silently made the UI lie — `host-stopped`/`tunnel-error` events were never listened to | main.js broadcasts + renderer listeners; P2P tab open triggers `p2p-get-status` | event chain wired |
| 6 | Discord RPC on/off setting never read from config | new `discordRpc.setEnabled()` (clears reconnect counters, wipes activity, disconnects); startup reads `enableDiscordRpc`, `save-config` updates it | 7 unit tests |
| 7 | `discordRpc.getIpcPath()` win32 branch was dead (loop + instant return, broken body) | Unix search behavior preserved, dead code removed | syntax + unit test |
| 8 | Default instance was created as fabric with a vanilla version — every new user hit a "version/loader mismatch" on first launch | `ensureDefaultInstance` now creates vanilla + one-time migration of the old fabric+`loaderVersion:null` default (real fabric instances untouched) | 7 unit tests (fresh install / migration / real fabric preserved / default delete rejected) |
| 9 | `start.sh` used GNU-only `grep -oP` (breaks on macOS/BSD) and never looked at the launcher's own Java runtimes | portable `sed` version parse + Adoptium/launcher runtime paths first in the search list | `bash -n`, mock-java run, real java output parse (21 / legacy 1.8) |

## 2) Loader system — Forge / NeoForge / OptiFine

**Root cause:** `ensureLoaderProfileJson` could only produce Fabric/Quilt profiles; Forge,
NeoForge and OptiFine ended in `throw Error`. Loader detection depended on profile name prefixes.

**New architecture** (verified with real-network tests):

- **Forge:** uses MCLC's built-in ForgeWrapper flow. Installer jar downloaded from
  `maven.minecraftforge.net`, `version.json` + `install_profile.json` validated inside the zip
  (test: HTTP 200, 6.3 MB), then `options.forge = installerPath` + `version.custom = null` —
  MCLC caches the profile at `root/forge/{profileId}/version.json`. `checkVersionIsDownloaded`
  accepts both locations.
- **NeoForge:** same flow with the 1.21+ naming (`neoforge-21.x.y-universal.jar` inside the zip).
- **OptiFine:** honest manual note — OptiFine ships no public automated API; the loader is
  installed by the user from the official release page, the launcher detects the resulting
  profile and launches it correctly.

## 3) Security fixes

- URL validation for all download hosts (no arbitrary host redirect).
- `sanitizeInstanceId` / `sanitizeModFilename` / `resolveSafePath` applied at every
  filesystem boundary; traversal (`..`) test cases included.
- sha1 verification for every Modrinth download (hash mismatch → rejected).
- MS auth tokens stored through `safeStorage` with plaintext fallback + visible warning.

## 4) Logic errors

- Benchmark started/stopped around the real `launch-game` boundaries (`startedAtInternal`
  anchored at IPC entry).
- `toggle-mod` / `delete-mod` / autofix writes are transactional through the instance ledger.
- Modpack & perf-pack installs record Time Machine transactions (`perfpack-*`,
  later `modupdate-*`, `sharecode-*`).
- ConfigStore partial updates no longer clobber unrelated fields.

## 5) javaDetector — cross platform (Windows/macOS/Linux/BSD)

Search order: launcher-managed runtimes (`~/.devlauncher/java_runtimes`) → Adoptium
locations → system PATH → well-known OS paths. Portable `sed` version parsing; unit tests
with mock java (21 / legacy 1.8).

## 6) Dependencies

- `electron-updater` 6.8.9 added (publish block: GitHub, NSIS/AppImage/DMG).
- `adm-zip` reused for instance/screenshot/diagnostics zips.
- `qrcode` 1.5.4 added in v0.13 (pure JS, no native bits) for the LAN QR canvas.

## 7) UI (CSS/HTML)

- Renderer id ↔ HTML id audit (145 ids, zero missing after Phase 4).
- All hardcoded font stacks moved to a `--ui-font` CSS variable with an OS-aware selector.
- All user-visible strings are English (crash rules JSON included); no CJK/Cyrillic/garbled
  characters remain in code (automated sweep).

## 8) Test summary

- 17 suites, **305 tests, 0 failures** in `/tmp/opencode/devlauncher-tests/*.test.js`.

**Real-network probes (run on this machine):**
- Mojang manifest 1.21.1 resolved; asset index + 2 assets fetched via the prefetch pool.
- Forge installer jar download validated (HTTP 200, sha1 match, 6.3 MB).
- Fabric meta + Modrinth `version_file` by sha1 both answered as expected.

**Syntax:** `main.js`, `renderer.js` and 15 service/util files all pass `node --check`
(no `preload.js` in this project — `nodeIntegration: true`; an earlier audit round
mistakenly listed that nonexistent file, not a code defect).

## 9) Remaining / notes (not bugs — deliberate decisions)

- Package-manager builds (AUR/portage/nix/xbps) deferred.
- All local changes are uncommitted until the user signs `SHA256SUMS.asc` and releases.
- App ID switched to `com.unstablecelik.devlauncher` before the first public release.

## 10) Git push order

```bash
git add -A
git commit -m "v0.13: phases 1-4 …"
git push -u origin main
# if dist artifacts should be added: append the dist file paths to the same command
```
