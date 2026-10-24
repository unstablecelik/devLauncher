#!/usr/bin/env bash
# devLauncher start script
# Automatically picks the best available Java (prefers 27 > 25 > 21)
# and launches Electron with that Java path pre-configured.

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Find best Java ─────────────────────────────────────────────────────────
find_java() {
    local candidates=(
        "$HOME/.devlauncher/java_runtimes/openjdk-27/bin/java"
        "$HOME/.devlauncher/java_runtimes/openjdk-25/bin/java"
        "$HOME/.devlauncher/java_runtimes/openjdk-21/bin/java"
        "$HOME/Library/Java/JavaVirtualMachines/openjdk-27/Contents/Home/bin/java"
        "$HOME/Library/Java/JavaVirtualMachines/openjdk-25/Contents/Home/bin/java"
        "$HOME/Library/Java/JavaVirtualMachines/openjdk-21/Contents/Home/bin/java"
        "/usr/lib/jvm/java-27-openjdk/bin/java"
        "/usr/lib/jvm/java-27-openjdk-amd64/bin/java"
        "/usr/lib/jvm/temurin-27/bin/java"
        "/usr/lib/jvm/java-25-openjdk/bin/java"
        "/usr/lib/jvm/java-25-openjdk-amd64/bin/java"
        "/usr/lib/jvm/java-21-openjdk/bin/java"
        "/usr/lib/jvm/java-21-openjdk-amd64/bin/java"
        "/usr/local/openjdk-21/bin/java"
        "/usr/local/bin/java"
    )
    for c in "${candidates[@]}"; do
        if [ -x "$c" ]; then echo "$c"; return; fi
    done
    command -v java 2>/dev/null || echo "java"
}

JAVA_PATH=$(find_java)
# Portable version parse (no GNU -oP): works on macOS/BSD/Linux
JAVA_VER=$("$JAVA_PATH" -version 2>&1 | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p' | head -1)
echo "[devLauncher] Using Java ${JAVA_VER} -> ${JAVA_PATH}"

# Export so main.js can pick it up as the default java path
export DEVLAUNCHER_JAVA_PATH="$JAVA_PATH"
export ELECTRON_OZONE_PLATFORM_HINT=x11
export MESA_GL_THREAD=1
export __GL_THREADED_OPTIMIZATIONS=1

cd "$SCRIPT_DIR"
exec npx electron . "$@"
