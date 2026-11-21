#!/bin/sh
# Written by `glen install --agent cursor --cloud`.
[ -n "$GLEN_API_KEY" ] || exit 0
if command -v glen >/dev/null 2>&1; then exec glen "$@"; fi
glen="$HOME/.local/bin/glen"
if [ ! -x "$glen" ]; then
  npm install -g --prefix "$HOME/.local" @tryglen/cli </dev/null >/dev/null 2>&1 || exit 0
fi
exec "$glen" "$@"
