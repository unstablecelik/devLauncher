#!/bin/sh
# Run devLauncher with the system Electron on FreeBSD (see docs/BSD.md).
# Usage: ./freebsd-run.sh [extra electron arguments]
set -e
for candidate in electron42 electron41 electron40 electron; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" . "$@"
  fi
done
echo "No system Electron found. Install one: 'pkg search electron' then 'pkg install electron42' (see docs/BSD.md)" >&2
exit 1
