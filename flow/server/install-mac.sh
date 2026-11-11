#!/bin/bash
# One-time setup on macOS so the canvas page can start the bridge by itself.
# It makes a small helper app (~/Applications/Flow Bridge.app) that answers the address flowbridge://start
# by starting this folder's server in the background. Nothing runs until the page (or you) asks for it.
#   ./install-mac.sh              install or update
#   ./install-mac.sh --uninstall  remove the helper (the saved login in ~/.flow-bridge is kept)
set -euo pipefail

[ "$(uname)" = "Darwin" ] || { echo "macOS 전용입니다."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/Flow Bridge.app"
DIR="$HOME/.flow-bridge"
LAUNCHER="$DIR/start.sh"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [ "${1:-}" = "--uninstall" ]; then
  [ -d "$APP" ] && "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
  rm -rf "$APP" "$LAUNCHER"
  echo "실행 도우미를 지웠습니다. 로그인 정보($DIR/state.json)는 그대로 있습니다."
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js를 찾지 못했습니다. https://nodejs.org 에서 20 이상을 설치한 뒤 다시 실행하세요."; exit 1; }
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] || { echo "Node.js 20 이상이 필요합니다 (지금: $("$NODE" -v))."; exit 1; }
[ -d "$HERE/node_modules" ] || (cd "$HERE" && npm install --no-audit --no-fund)

# The public page that may call the bridge: https://<owner>.github.io, taken from this clone's GitHub address.
OWNER="$(cd "$HERE" && git remote get-url origin 2>/dev/null | sed -nE 's#.*github\.com[:/]([^/]+)/.*#\1#p' | tr '[:upper:]' '[:lower:]')"
ORIGINS="${FLOW_ALLOWED_ORIGINS:-${OWNER:+https://$OWNER.github.io}}"

mkdir -p "$DIR" "$HOME/Applications"
chmod 700 "$DIR"
cat > "$LAUNCHER" <<LAUNCH
#!/bin/bash
# Written by install-mac.sh. Starts the bridge unless it is already answering.
curl -s -m 2 -o /dev/null http://127.0.0.1:8787/api/status && exit 0
cd "$HERE" || exit 1
# Programs started from an app get a bare PATH; add the usual places so node and the claude command are found.
export PATH="$(dirname "$NODE"):\$HOME/.local/bin:\$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:\$PATH"
FLOW_ALLOWED_ORIGINS="$ORIGINS" nohup "$NODE" server.mjs >> "$DIR/bridge.log" 2>&1 &
LAUNCH
chmod 700 "$LAUNCHER"

SRC="$(mktemp -t flowbridge).applescript"
cat > "$SRC" <<SCRIPT
on startBridge()
	do shell script quoted form of "$LAUNCHER" & " > /dev/null 2>&1 &"
end startBridge
on open location theURL
	startBridge()
end open location
on run
	startBridge()
end run
SCRIPT
rm -rf "$APP"
osacompile -o "$APP" "$SRC"
rm -f "$SRC"

PLIST="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
"$PB" -c "Add :CFBundleIdentifier string io.github.flow-bridge" "$PLIST" 2>/dev/null || "$PB" -c "Set :CFBundleIdentifier io.github.flow-bridge" "$PLIST"
"$PB" -c "Add :LSUIElement bool true" "$PLIST" 2>/dev/null || "$PB" -c "Set :LSUIElement true" "$PLIST"
"$PB" -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleURLTypes array" "$PLIST"
"$PB" -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLName string Flow Bridge" "$PLIST"
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
"$PB" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string flowbridge" "$PLIST"
# The app was changed after it was built, so it is signed again (local, ad-hoc) and registered for the address.
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
"$LSREGISTER" -f "$APP"

echo "설치했습니다: $APP"
echo "이제 워크플로우 페이지의 연결 패널에서 '확인'을 누르면 브리지가 켜집니다."
echo "처음 누를 때 Chrome이 'Flow Bridge 열기'를 물으면 허용하세요 ('항상 허용'을 체크하면 다시 묻지 않습니다)."
[ -n "$ORIGINS" ] && echo "브리지를 쓸 수 있는 공개 페이지: $ORIGINS  (그리고 http://localhost:8787/flow/)"
echo "기록: $DIR/bridge.log"
