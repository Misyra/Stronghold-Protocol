#!/bin/sh
# Keep this wrapper beside sp-integrity-check.py when installing into /usr/local/sbin.
set -eu
exec /usr/bin/python3 "$(dirname "$0")/sp-integrity-check.py" "$@"
