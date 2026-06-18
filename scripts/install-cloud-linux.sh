#!/usr/bin/env bash
# AntlerOffice cloud (Linux) headless install — OpenClaw + AntlerOffice server + ECS relay
set -euo pipefail

INSTALL_DIR="${ANTLEROFFICE_INSTALL_DIR:-$HOME/.local/share/antleroffice}"
DATA_DIR="${ANTLEROFFICE_DATA_DIR:-$HOME/.antleroffice2}"
NODE_MIN=20

echo "==> AntlerOffice cloud install (Linux)"
mkdir -p "$INSTALL_DIR" "$DATA_DIR"

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.versions.node.split('.')[0]")" -lt "$NODE_MIN" ]]; then
  echo "Node.js $NODE_MIN+ required. Install from https://nodejs.org/ then re-run."
  exit 1
fi

if [ ! -d "$INSTALL_DIR/app" ]; then
  echo "==> Download latest release (set ANTLEROFFICE_RELEASE_URL to override)"
  RELEASE_URL="${ANTLEROFFICE_RELEASE_URL:-https://github.com/antlerzone/antleroffice/releases/latest/download/antleroffice-linux-headless.tar.gz}"
  tmp="$(mktemp -d)"
  curl -fsSL "$RELEASE_URL" -o "$tmp/pkg.tar.gz" || {
    echo "Download failed. For dev, clone the repo and set ANTLEROFFICE_SOURCE_DIR."
    if [ -n "${ANTLEROFFICE_SOURCE_DIR:-}" ]; then
      cp -a "$ANTLEROFFICE_SOURCE_DIR/." "$INSTALL_DIR/app/"
    else
      exit 1
    fi
  }
  if [ -f "$tmp/pkg.tar.gz" ]; then
    mkdir -p "$INSTALL_DIR/app"
    tar -xzf "$tmp/pkg.tar.gz" -C "$INSTALL_DIR/app"
    rm -rf "$tmp"
  fi
fi

cd "$INSTALL_DIR/app"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
npm run build 2>/dev/null || true

if ! command -v openclaw >/dev/null 2>&1; then
  echo "==> Installing OpenClaw"
  npm install -g openclaw@latest || sudo npm install -g openclaw@latest
fi

UNIT="$HOME/.config/systemd/user/antleroffice.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=AntlerOffice cloud server
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/app
Environment=ANTLEROFFICE_PACKAGED=1
Environment=ANTLEROFFICE_DATA_DIR=$DATA_DIR
Environment=PORT=3020
ExecStart=$(command -v node) --env-file=$INSTALL_DIR/app/.env $INSTALL_DIR/app/server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable antleroffice.service
systemctl --user restart antleroffice.service

echo ""
echo "AntlerOffice cloud service started."
echo "Sign in with device code: open $INSTALL_DIR/app and visit office.antlerzone.com"
echo "Or copy .env from AntlerOffice2/.env.example and set ECS_BASE_URL, then:"
echo "  systemctl --user restart antleroffice"
echo ""
echo "Update later: antleroffice-update  (or: curl -fsSL .../install-cloud-linux.sh | bash)"
