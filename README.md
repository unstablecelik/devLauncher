# devLauncher 🚀

A next-generation, high-performance, open-source Minecraft Launcher built with Electron and Node.js.

Designed for extreme speed, flexibility, and seamless multiplayer experience. Features native support for **Vanilla, Fabric, Quilt, NeoForge, and Forge** with isolated instances and built-in P2P world sharing.

> Download the latest build at the [project website](https://github.com/unstablecelik/devLauncher#readme) or from [Releases](https://github.com/unstablecelik/devLauncher/releases/latest).

---

## ✨ Key Features & Stack
- 🧩 **Isolated Instance Environments:** Create separate game profiles with isolated `mods`, `config`, `saves`, and `resourcepacks` directories.
- ⚙️ **Installed Mods Manager (Mod Control):** Enable, disable (`.disabled`), or delete installed mods directly inside the launcher without opening folders.
- 🛍️ **Modrinth Manager (Mods, Shaders, Resourcepacks):** Live search with real-time mod icons, supported versions, and loader badges. Includes Enter-key fast search.
- ⏱ **Mod Time Machine:** Every install, update, removal and toggle is recorded — undo anything with one click from the content store.
- 🩺 **Mod Doctor & Integrity Sweep:** Automated mod health diagnostics, checksum verification of every version library, and one-click redownload of corrupted jars.
- 🤖 **Automatic Mod Updates:** Update Checker scans Modrinth and updates all outdated mods in one click.
- 🖼 **World Preview:** Sandbox-free spawn-chunk heightmap preview of any world (1.14+), rendered from the region files.
- 🌐 **Zero-Config P2P Multiplayer (Share World Online):** Share your local Minecraft LAN world with friends over the internet — no Hamachi, no port forwarding, no rented servers. Includes a QR-code generator for LAN join links and **Remote Play** via Sunshine (Moonlight) auto-configuration.
- 🎮 **1-Click Server:** Turn any instance into a ready-to-run dedicated server (vanilla + Fabric) with a generated start script.
- 🔗 **Share Codes:** Compressed launcher-agnostic codes (`DL13-…`) to give friends your whole instance setup in one line.
- 📊 **Launch Benchmark:** A/B compare launcher runs (cold/warm start, TTFP) right inside the Dashboard.
- 💾 **Instance Snapshots:** Capture mods + config + options.txt and roll back at any time — restores always keep an automatic pre-restore snapshot.
- 🛟 **Full Self-Update:** The launcher updates itself to the newest release; imports from other launchers via a guided wizard.
- 👤 **Account & Skin Hub:** Account onboarding and skins management, plus per-instance playtime tracking.
- ⚡ **1-Click OpenJDK Auto-Installer:** Automatically download and configure official OpenJDK binaries (**Java 8, 17, 21, 25, and Java 27 Next-Gen**).
- ⚡ **ZGC & Aikar G1GC Performance Tuning:** Low-latency Zero-Stutter Garbage Collector configuration for high FPS and smooth gameplay.
- 📸 **Screenshot Manager & Zip Exporter:** View screenshots taken per instance and export them as compressed `.zip` archives.
- 🎨 **Theme Store & Fonts:** Built-in color themes (Catppuccin, Nord, OLED Black, Dracula, Rose Pine…), selectable UI fonts (Departure Mono, JetBrains Mono, Iosevka, Cascadia, Zed Mono, plus system fonts).
- 🎧 **Automatic Discord Rich Presence:** Instant background reconnection and activity status for Discord and Vesktop.
- 🔒 **Privacy Posture:** No shell/terminal command execution in the launcher code; downloads are checksum-verified (sha1) and the ledger keeps every change reversible.

---

## 🛠️ Build & Distribute (Release Packages)

### Prerequisites

- [Node.js (v18+)](https://nodejs.org/)
- `npm` (this repo no longer ships a Yarn lockfile)

### 📦 Build Executables

#### For Windows (`.exe` / Portable Dir):
```bash
npm run dist
```
*Output will be generated in `dist/win-unpacked`.*

#### For Linux (`.AppImage` & `.tar.gz`):
```bash
npm run dist:linux
```
*Output AppImage & tar.gz will be generated in `dist/`.*

---

## 🚀 Running from Source

1. Clone the repository:
   ```bash
   git clone https://github.com/unstablecelik/devLauncher.git
   cd devLauncher
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Launch the app:
   ```bash
   npm start
   ```
4. Run the test suite (no network access needed — everything is local):
   ```bash
   npm test
   ```

---

## 🖥️ Supported Platforms

### Officially supported (Electron prebuilts + auto Java installer)

| OS | Architectures | Formats / notes |
|---|---|---|
| Windows 10/11 | x64, arm64, ia32 (32-bit x86) | NSIS + portable `.zip` |
| macOS 11+ (Big Sur+) | x64 (Intel), arm64 (Apple Silicon), universal | `.dmg` + `.zip`. Universal bundles run on both. |
| Linux (glibc) | x64, arm64, armv7l (32-bit ARM) | AppImage, `.deb`, `.rpm`, `.tar.gz`, pacman, apk. Distro families: Debian/Ubuntu/Mint, Fedora/RHEL/openSUSE, Arch/Manjaro, Gentoo and other glibc-based distros. |

> Notes:
> - Electron does **not** ship official Linux builds for 32-bit x86 (`ia32`). Only 32-bit ARM (`armv7l`) is available there, mostly for Raspberry Pi.
> - Apple code signing / notarization is supported end-to-end but **off by default**: set the signing environment variables (`CSC_LINK`, `APPLE_ID`, …) to enable it. See [`docs/CODE-SIGNING.md`](docs/CODE-SIGNING.md). Windows binaries are signed the same way when `CSC_LINK` / the signtool variables are provided.

### Best-effort / experimental (community Electron + system Java)

| OS / stack | Architectures | Notes |
|---|---|---|
| Linux (musl) | x64, arm64, armv7l | Alpine (and Void musl best-effort). Uses `apk`/`.tar.gz`. May need system libraries. |
| FreeBSD | x64 | Uses `freebsd` target + the FreeBSD Electron port; Java auto-installer is disabled, install Temurin/OpenJDK via `pkg`. |
| OpenBSD / NetBSD | x64 | Java detector reuses BSD search paths; Electron packaging is community-only. |
| Linux (glibc, RISC-V) | riscv64 | Requires a community RISC-V Electron build (`electron-riscv`); not produced by the standard builder. Temurin riscv64 can be auto-installed. |

### Known limitations

- Automatic OpenJDK installation uses Eclipse Temurin (`api.adoptium.net`) and supports `windows`, `mac`, `linux`, `alpine-linux`. BSD has no Temurin OS target; install Java manually there.
- RISC-V Electron builds are not official and must be configured via a custom `electronDist`.

---

## 📄 License

Distributed under the **GNU GPL-3.0** License. See [LICENSE](LICENSE) for more information.
