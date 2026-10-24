# FreeBSD notes

The launcher is Electron + JavaScript — no native/compiled parts — so it runs
on FreeBSD with a system Electron provided by the ports tree. Not first-party
tested (upstream builds target Windows/macOS/Linux); treated as
community-supported.

## Option 1 — system Electron (recommended)

```sh
pkg install electron42          # or the newest `pkg search electron` hit
git clone https://github.com/unstablecelik/devLauncher
cd devLauncher
npm install --omit=dev          # runtime dependencies only
./freebsd-run.sh
```

`freebsd-run.sh` picks `electron42` → `electron` in order and starts the
launcher with the system binary.

## Option 2 — Linuxulator (fallback)

The Linux x64 zip can run under FreeBSD's Linux ABI layer:

```sh
pkg install linux-base          # Linuxulator userland of your chosen distro
unzip devLauncher-<version>-win-linux-x64.zip
/linux emulation steps vary by release; the generic flow is:
sysrc linux_enable="YES"        # boot loader rc script
service linux start
```

Heavier and more fragile than Option 1; only worth it when the ports tree is
not an option.

## Package targets (`dist:bsd` script)

The repository keeps an experimental `dist:bsd` script
(`electron-builder --linux freebsd`). It packages a tar.gz using the Linux
Electron binary, so on FreeBSD it is *not* guaranteed to run natively — it is
kept for packagers that want a starting artifact. Prefer Option 1 above.
