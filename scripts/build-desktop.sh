#!/usr/bin/env bash
# ==============================================================================
# GRIMALKIN 1010 — build the desktop apps (Tauri) into release/
# ==============================================================================
# Usage: scripts/build-desktop.sh <target>...
#
#   mac            Universal (arm64 + x86_64) .app in a .dmg     — needs macOS + Rust
#   linux-arm64    .deb, .rpm, .AppImage                         — needs Docker
#   linux-x64      same, x86_64 (emulated on Apple Silicon: slow, and no AppImage)
#   windows        arm64 + x64 NSIS installers and portable .exe — needs a win-devvm VM
#   all            everything above
#
# Environment:
#   WIN_DEVVM_DIR  win-devvm checkout (default: found via `build-tooling where win-devvm`,
#                  else ~/src/tools/win-devvm)
#   WIN_ARCHES     Windows targets, default "arm64 x64"
#
# Each build also runs the app's self-test (GRIMALKIN_SELFTEST) and saves the
# report next to the artifacts as release/selftest-<platform>.json.
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/release"
VERSION="$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")"
NAME="Grimalkin-1010_${VERSION}"
mkdir -p "$OUT"

build_mac() {
    [[ "$(uname -s)" == Darwin ]] || { echo "mac: needs a macOS host" >&2; return 1; }
    cd "$ROOT"
    [[ -d node_modules ]] || npm ci --no-fund --no-audit
    rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
    npx tauri build --target universal-apple-darwin --bundles app
    local app="src-tauri/target/universal-apple-darwin/release/bundle/macos/Grimalkin 1010.app"
    # Plain hdiutil image: Tauri's own dmg step scripts Finder, which fails
    # without a logged-in desktop session.
    local stage; stage="$(mktemp -d)"
    cp -R "$app" "$stage/" && ln -s /Applications "$stage/Applications"
    hdiutil create -volname "Grimalkin 1010" -srcfolder "$stage" -ov -format UDZO \
        "$OUT/${NAME}_macos-universal.dmg" >/dev/null
    rm -rf "$stage"
    GRIMALKIN_SELFTEST="$OUT/selftest-macos.json" "$app/Contents/MacOS/grimalkin-1010" \
        || echo "mac: self-test failed (see release/selftest-macos.json)" >&2
}

build_linux() {   # $1 = arm64 | x64
    local arch="$1" platform
    case "$arch" in arm64) platform=linux/arm64 ;; x64) platform=linux/amd64 ;; esac
    local image="grimalkin-desktop-build:$arch"
    # The AppImage tool (linuxdeploy) fails under CPU emulation, so it is only
    # built when the container runs natively. Override with BUNDLES=...
    local bundles=deb,rpm native
    case "$(uname -m)" in arm64|aarch64) native=arm64 ;; *) native=x64 ;; esac
    [[ "$arch" == "$native" ]] && bundles=deb,rpm,appimage
    # Pull the public base image anonymously: the default Docker config asks
    # the macOS keychain for credentials, which fails when the screen is locked
    # or over SSH.
    local host anon; host="$(docker context inspect -f '{{.Endpoints.docker.Host}}')"
    anon="$(mktemp -d)"; echo '{"credsStore":"anon"}' > "$anon/config.json"
    # A credential helper that always answers "no credentials stored".
    printf '#!/bin/sh\ncase "$1" in list) echo "{}" ;; get) echo "credentials not found in native keychain"; exit 1 ;; esac\n' \
        > "$anon/docker-credential-anon"
    chmod +x "$anon/docker-credential-anon"; PATH="$anon:$PATH"
    [[ -d "$HOME/.docker/cli-plugins" ]] && ln -s "$HOME/.docker/cli-plugins" "$anon/cli-plugins"
    export DOCKER_CONFIG="$anon" DOCKER_HOST="$host"
    docker build --platform "$platform" -t "$image" -f "$ROOT/scripts/desktop/Dockerfile.linux" "$ROOT/scripts/desktop"
    docker run --rm --platform "$platform" \
        -v "$ROOT:/src:ro" -v "$OUT:/out" \
        -v "grimalkin-cargo-$arch:/usr/local/cargo/registry" \
        -v "grimalkin-target-$arch:/cache/target" \
        -e CARGO_TARGET_DIR=/cache/target -e BUNDLES="${BUNDLES:-$bundles}" \
        "$image" bash /src/scripts/desktop/linux-in-container.sh "$arch" "$VERSION"
}

build_windows() {
    local vmdir="${WIN_DEVVM_DIR:-}"
    if [[ -z "$vmdir" ]] && command -v build-tooling >/dev/null; then vmdir="$(build-tooling where win-devvm 2>/dev/null || true)"; fi
    vmdir="${vmdir:-$HOME/src/tools/win-devvm}"
    local vm="$vmdir/vm.sh"
    [[ -x "$vm" ]] || { echo "windows: win-devvm not found at $vmdir (set WIN_DEVVM_DIR)" >&2; return 1; }
    "$vm" status | grep -q 'tools: DONE' || { echo "windows: VM not ready — run '$vm start' and '$vm wait'" >&2; return 1; }
    local tmp; tmp="$(mktemp -d)"
    # COPYFILE_DISABLE: keep macOS "._*" metadata files out of the archive
    # (Tauri tries to parse capabilities/._default.json and fails).
    COPYFILE_DISABLE=1 tar -C "$ROOT" --exclude=node_modules --exclude=dist --exclude=release --exclude=.git \
        --exclude=src-tauri/target --exclude=.DS_Store -czf "$tmp/grimalkin-src.tgz" .
    "$vm" push "$tmp/grimalkin-src.tgz" grimalkin-src.tgz
    "$vm" push "$ROOT/scripts/desktop/windows-build.ps1" grimalkin-build.ps1
    "$vm" ssh "powershell -NoProfile -ExecutionPolicy Bypass -File grimalkin-build.ps1 -Arches '${WIN_ARCHES:-arm64 x64}' -Version $VERSION"
    "$vm" pull grimalkin-out "$tmp/out"
    cp "$tmp"/out/* "$OUT/"
    rm -rf "$tmp"
}

[[ $# -gt 0 ]] || { sed -n '2,22p' "$0"; exit 2; }
for target in "$@"; do
    case "$target" in
        mac) build_mac ;;
        linux-arm64) build_linux arm64 ;;
        linux-x64) build_linux x64 ;;
        windows) build_windows ;;
        all) build_mac; build_linux arm64; build_linux x64; build_windows ;;
        *) echo "unknown target: $target" >&2; exit 2 ;;
    esac
done
ls -lh "$OUT"
