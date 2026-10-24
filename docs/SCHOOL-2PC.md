# Two-Computer School Setup (LAN direct play)

Target: two computers on the same network — one x86_64, one x86 (32-bit) —
playing the same Minecraft world together without any internet relay, with
**no administrator rights** needed at any point.

## 1. Install the launcher on both PCs

| PC | Artifact | Why |
|---|---|---|
| x86_64 (64-bit) | `devLauncher-<version>-win.zip` | portable zip, extracts to any folder |
| x86 (32-bit) | `devLauncher-<version>-ia32-win.zip` | 32-bit Electron build for legacy CPUs |

Both are plain portable zips: unzip to `Desktop`, `C:\Games\devLauncher` or a
USB stick — no installer, no registry, no admin. If an installer is preferred
on the 64-bit PC, `devLauncher-Setup-<version>.exe` installs per-user into
`%LOCALAPPDATA%\Programs\devLauncher` (Inno Setup, `PrivilegesRequired=lowest`
— accepts the dialog without admin).

**USB mode (optional):** create an empty file named `portable.marker` next to
`devLauncher.exe`. All settings, cache and instances then live in a `data`
folder beside the launcher, nothing touches `%APPDATA%`, and the stick can be
moved between machines.

## 2. Make both instances identical (share code)

1. On the host PC: create (or select) the instance with the **same Minecraft
   version and loader** that both PCs must use.
2. Open the **Share Code** tab and export the code / copy it.
3. On the second PC: import that share code. The instance (version + loader +
   mods list) is mirrored automatically.
   - Without a share code both PCs must pick the same version + loader
     manually — mismatch is the single most common "cannot join" cause.

## 3. Host the world (first PC)

1. In the launcher select the right instance and launch the game.
2. In the game: `Esc → Open to LAN`.
3. Minecraft prints the port in the chat: like `Local game hosted on port
   42564`. Type that port into the launcher's P2P tab (or leave 25565 when
   using a real server / `server.properties` setup — fixed ports are easier
   for recurring firewall rules).
4. The **LAN Direct** block now lists this PC's addresses as
   `192.168.x.x:<port>` — press **copy** next to the one matching your
   school/lab network.

## 4. Join (second PC)

1. Launch the game with the imported instance.
2. Multiplayer → **Direct Connect** → paste `192.168.x.x:<port>`.
3. The P2P tab on the joining PC has a **Test this PC** row: enter the host
   IP + port and press Test. Results:
   - `✅ Reachable in N ms` → the path is fine, join via Direct Connect.
   - `❌ refused (host reachable, port closed)` → host has not opened the
     world yet, or wrong port.
   - `❌ timeout` → see the network caveats below.

## 5. Windows firewall (one time, per PC)

On the **host** PC Windows Defender asks once after the game opens a port —
click **Allow**. If that prompt was dismissed:

- The P2P Test row is the quickest way to confirm the state.
- With admin rights the rule can be added manually (host side):
  ```
  netsh advfirewall firewall add rule name="Minecraft LAN" dir=in action=allow protocol=TCP profile=any localport=25565
  netsh advfirewall firewall add rule name="Minecraft LANUDP" dir=in action=allow protocol=UDP profile=any localport=25565
  ```

## 6. Network caveats

- **AP / client isolation** (common on school and hotel Wi-Fi): clients can
  reach the internet but never each other. Symptom: the Test row times out
  even though both PCs are online. Fixes: use a network cable between the
  PCs / a cheap switch, or ask IT to disable isolation for those two devices.
- **School proxy (MEB etc.):** the launcher honours proxy settings
  (Settings → Network → custom proxy with credentials) for Internet-only
  tasks: version downloads, Java runtime install, Modrinth. LAN play itself
  needs no proxy.
- Uninstaller/updater note: on the installed (Inno) PC, the self-updater runs
  the new Setup quietly and the launcher restarts itself via the Windows
  Restart Manager. Portable zips update in place (wait-and-swap).

## 7. Quick checklist

- [ ] Both PCs: launcher from the matching zip (`win` / `ia32`)
- [ ] Same Minecraft version + loader on both (share code transfers it)
- [ ] Host: game running, world Open to LAN, chat port typed in the launcher
- [ ] Guest: Test row shows ✅, then Direct Connect `IP:port`
- [ ] If it fails: Test row verdict → firewall first, then isolation
