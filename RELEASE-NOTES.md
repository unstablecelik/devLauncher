# devLauncher v0.13.0

The biggest release yet: 20 new features across four phases, plus three hardening phases (modal/networking/instance rewrites) — verified by the in-repo test suite (`npm test`, 119 assertions across 6 suites).

## Highlights

- **Self-Update**: self-hosted update pipeline for every packaging shape — Inno Setup (Windows, silent + Restart Manager relaunch), portable zip (in-place wait-and-swap), AppImage/DMG dist profiles. Downloads are sha256-verified against the release `SHA256SUMS` and honour the network proxy settings.
- **Mod Update Checker + Update All**: every installed jar is identified by its sha1 on Modrinth and can be updated in place with hash verification — and everything lands in the Time Machine for one-click undo.
- **Share Code**: export an instance + its whole mod list as a single `DL13-…` code; the receiver gets a fresh instance with every Modrinth mod automatically downloaded and verified.
- **1-Click Server**: turn an instance into a runnable dedicated server folder (server jar, mods, eula.txt, start.sh / start.bat).
- **Remote Play**: Sunshine detection + app registration + Moonlight PIN pairing; devLauncher auto-launches instances via `--launch-instance=<id>`.
- **World Preview**: stylized heightmap of your spawn chunk straight from the world's region file — no game required.
- **LAN QR + IP list**: share a world on the same Wi-Fi in one scan.
- **Time Machine**: every mod install/update/remove/toggle is recorded with sha1 object backups and can be undone.
- **Mod Doctor**: jar health check (duplicates, loader mismatch, missing deps, suspicious content).
- **Import Wizard**: brings Prism / MultiMC / official-launcher instances over with saves, configs and packs.
- **Zero-Cold-Start Prefetch + TTFP Benchmark**: assets and libraries arrive before you press Play; the Dashboard shows the real time-to-playable.
- **Account Hub + Skin Manager**: multiple Microsoft accounts (safeStorage-encrypted), offline accounts with correct UUIDs, skin upload via the clean Mojang API.
- **Instance Snapshots (v2)**: capture mods + config + options.txt into the content store and roll back at any time; every restore first takes an automatic *pre-restore* snapshot, so a rollback is always two-way.
- **Integrity Sweep**: verify every version library against the checksums declared in its version JSON, and redownload missing/corrupted jars with one click (sha1-verified).
- **Crash fix suggestions v2**: missing-dependency crashes can now be repaired from the crash modal — Sodium installs in one click, and unmatched dependency errors open a targeted Modrinth search.
- **New**: Interface font selector (Departure Mono / JetBrains Mono / Iosevka / Cascadia / Zed Mono + system fonts), Rosé Pine theme, persisted custom themes, per-instance playtime, diagnostics zip, first-run wizard, About panel, Discord Rich Presence with custom app id.
- **Phase 5 hardening**: English-only UI (the old partial Turkish switcher was removed), configurable prefetch bandwidth cap, prefetch A/B verdict on the Dashboard, and a full code-signing/notarization setup (`docs/CODE-SIGNING.md`) — plug in your certificate and signed builds come out of `npm run dist`.
- **Shell-free internals**: the launcher no longer spawns any shell tools — `which`, `where`, `ldd` and `tar` invocations were replaced with pure Node implementations (including a built-in tar.gz extractor).

## Reliability round (new in 0.13.0 final)

- **Modal system rewritten**: one central `openModal()` code path — the historical "a menu opens only once" bug is gone; every modal can be re-opened indefinitely and the first-run wizard can never re-grab the overlay mid-session.
- **Proxy-aware networking** (`netClient`): every download rides either Electron's Chromium stack (honours the system proxy) or a CONNECT-tunnel agent for the classic Node https paths — school / MEB networks with mandatory proxies finally work, including authenticated proxies and a manual proxy override in Settings.
- **Connectivity Doctor**: one click in Settings probes all 8 required endpoints (Mojang meta/libraries/assets/session, Modrinth API/CDN, Adoptium, GitHub) with 12s timeouts, classifies DNS-blocked vs. timeouts, and the result ships inside the diagnostics zip.
- **Instances rewritten (v2)**: no hidden "default" instance anymore — ids are `slug-<hash>`, creation needs an explicit name, every lookup is strict, the legacy default is migrated once into a normal deletable instance, and empty-state guides you to create your first one.
- **Windows polish**: single-instance lock (a second launcher copy just focuses the first), 2G RAM pre-selection on ≤8GB machines, and an Intel UHD 620 iGPU OpenGL note in Mod Doctor.
- **Test suite lives in the repo** (`npm test`), so it can never vanish again: instance v2 contract, proxy tunnel round-trips, UI id contract + modal rules, and the service battery.

## Notes

- FPS Rocket was removed — the 1-Click Performance Pack covers it (and now records into the Time Machine too).
- OptiFine still installs manually (no public API — by their choice).
- The launcher never streams video itself; Remote Play only configures Sunshine/Moonlight.

**SHA-256 checksums:** see `SHA256SUMS` (+ `SHA256SUMS.asc` detached GPG signature) in this release.
