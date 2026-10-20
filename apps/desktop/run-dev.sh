#!/bin/sh
# Launch the desktop app from a checkout. Clears ELECTRON_RUN_AS_NODE, which
# some hosts (including other Electron apps) export and which turns Electron into plain Node.
cd "$(dirname "$0")"
unset ELECTRON_RUN_AS_NODE
exec ./node_modules/.bin/electron . "$@"
