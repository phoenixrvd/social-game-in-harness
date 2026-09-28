#!/bin/sh
set -eu

# Creates a dedicated Ed25519 SSH deployment key without a passphrase.
# The key is stored as ~/.ssh/gh_<name>.
# Usage: sh keygen.sh <project-name-in-snake-case>

command -v ssh-keygen >/dev/null 2>&1 || { echo "ERROR: ssh-keygen not found" >&2; exit 1; }

NAME="${1:-}"
case "$NAME" in
  ""|*[!a-z0-9_]*) echo "ERROR: key name must be snake_case (a-z, 0-9, _)" >&2; exit 1 ;;
esac

SSH_DIR="$HOME/.ssh"
KEY_PATH="$SSH_DIR/gh_$NAME"

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

if [ -f "$KEY_PATH" ]; then
  echo "STATUS: exists"
else
  ssh-keygen -t ed25519 -N "" -f "$KEY_PATH" -C "gh_$NAME" -q
  echo "STATUS: created"
fi

if [ -f "$KEY_PATH.pub" ]; then
  cat "$KEY_PATH.pub"
else
  echo "ERROR: public key not found at $KEY_PATH.pub" >&2
  exit 1
fi
