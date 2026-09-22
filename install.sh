#!/usr/bin/env bash
# HumanRL one-line install:
#
#   curl -fsSL https://raw.githubusercontent.com/SecretSettler/HumanRL/main/install.sh | bash
#
# Clones (or updates) the repository into ~/HumanRL, installs dependencies
# and runs `pnpm humanrl:up`, which starts PostgreSQL, the API, the worker
# and the web app, loads the demo trace and opens it in your browser.
#
# Knobs (environment variables):
#   HUMANRL_DIR=~/somewhere   where to clone            (default ~/HumanRL)
#   HUMANRL_REPO=<url|path>   what to clone             (default the GitHub repo)
#   HUMANRL_NO_OPEN=1         do not open the browser
#   HUMANRL_HOST=1            run on the host even if Docker Compose exists
set -euo pipefail

REPO="${HUMANRL_REPO:-https://github.com/SecretSettler/HumanRL.git}"
DIR="${HUMANRL_DIR:-$HOME/HumanRL}"

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required. macOS: xcode-select --install · Debian/Ubuntu: sudo apt install git"

if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'
✖ Node.js is required (24 recommended, 22 works with a warning). Install one and rerun:
    macOS:   brew install node
    any OS:  https://nodejs.org/en/download  or  curl -fsSL https://fnm.vercel.app/install | bash && fnm install 24
EOF
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "Node.js $(node -v) is too old; HumanRL needs 22 or newer (24 recommended)."
fi
command -v corepack >/dev/null 2>&1 || die "corepack is missing from this Node.js install; run: npm install -g corepack"

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning $REPO into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

say "Installing dependencies (pnpm via corepack; first time takes a few minutes)"
corepack pnpm install --frozen-lockfile

say "Starting HumanRL"
exec corepack pnpm humanrl:up
