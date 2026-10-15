# devLauncher 🚀

A next-generation, high-performance, open-source Minecraft Launcher built with Electron and Node.js.

Designed for extreme speed, flexibility, and seamless multiplayer experience. Features native support for **Vanilla, Fabric, Quilt, NeoForge, and Forge** with isolated instances and built-in P2P world sharing.

---

## ✨ Key Features & Stack
- 🧩 **Isolated Instance Environments:** Create separate game profiles with isolated `mods`, `config`, `saves`, and `resourcepacks` directories.
- ⚙️ **Installed Mods Manager (Mod Control):** Enable, disable (`.disabled`), or delete installed mods directly inside the launcher without opening folders.
- 🛍️ **Modrinth Manager (Mods, Shaders, Resourcepacks):** Live search with real-time mod icons, supported versions, and loader badges. Includes Enter-key fast search.
- 🌐 **Zero-Config P2P Multiplayer (Share World Online):** Share your local Minecraft LAN world with friends over the internet without Hamachi, port forwarding, or renting servers.
- ⚡ **1-Click OpenJDK Auto-Installer:** Automatically download and configure official OpenJDK binaries (**Java 8, 17, 21, 25, and Java 27 Next-Gen**).
- ⚡ **ZGC & Aikar G1GC Performance Tuning:** Low-latency Zero-Stutter Garbage Collector configuration for high FPS and smooth gameplay.
- 📸 **Screenshot Manager & Zip Exporter:** View screenshots taken per instance and export them as compressed `.zip` archives.
- 🎨 **Theme Store:** Built-in color customization including Catppuccin, Nord, OLED Black, and Dracula themes.
- 🎧 **Automatic Discord Rich Presence:** Instant background reconnection and activity status for Discord and Vesktop.

---

## 🛠️ Build & Distribute (Release Packages)

### Prerequisites

- [Node.js (v18+)](https://nodejs.org/)
- [Yarn](https://yarnpkg.com/) or `npm`

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
   git clone https://github.com/fedevoral/devlauncher.git
   cd devlauncher
   ```
2. Install dependencies:
   ```bash
   yarn install
   # or
   npm install
   ```
3. Launch the app:
   ```bash
   npm start
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
> - Apple code signing / notarization is not configured; first launch may require "Open Anyway" on macOS.

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
