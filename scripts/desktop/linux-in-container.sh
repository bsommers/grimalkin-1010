#!/usr/bin/env bash
# Runs inside the Linux build container: /src = repo (read-only), /out = results.
set -euo pipefail
ARCH="$1"; VERSION="$2"
mkdir -p /build && cd /build
tar -C /src --exclude=node_modules --exclude=dist --exclude=release --exclude=.git \
    --exclude=src-tauri/target -cf - . | tar -xf -
npm ci --no-fund --no-audit
BUNDLES="${BUNDLES:-deb,rpm,appimage}"
npx tauri build --bundles "$BUNDLES"
B="$CARGO_TARGET_DIR/release/bundle"
for f in "$B"/deb/*.deb "$B"/rpm/*.rpm "$B"/appimage/*.AppImage; do
    [ -e "$f" ] || continue
    ext="${f##*.}"
    cp "$f" "/out/Grimalkin-1010_${VERSION}_linux-${ARCH}.${ext}"
done
# Self-test under a virtual display (software GL).
set +e
GRIMALKIN_SELFTEST="/out/selftest-linux-${ARCH}.json" WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    xvfb-run -a -s "-screen 0 1280x800x24" "$CARGO_TARGET_DIR/release/grimalkin-1010"
echo "selftest exit=$?"
