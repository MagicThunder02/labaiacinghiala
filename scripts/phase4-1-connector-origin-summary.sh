#!/usr/bin/env bash
set -euo pipefail

SINCE="${1:-2 minutes ago}"
LOGS="$(sudo journalctl -u baia-connector --since "$SINCE" --no-pager)"

echo "===== BAIA PHASE 4.1 ORIGIN DIAGNOSTICS ====="
echo "Since: $SINCE"
echo

echo "=== CLIENT KIND COUNTS ==="
printf '%s\n' "$LOGS" \
  | grep 'media_source=direct_file' \
  | grep -o 'client_kind=[^ ]*' \
  | sort | uniq -c || true

echo
echo "=== RANGE SIZES BY CLIENT KIND ==="
for kind in native_media_source legacy_media_bridge unknown; do
  echo "-- $kind --"
  printf '%s\n' "$LOGS" \
    | grep 'media_source=direct_file' \
    | grep "client_kind=$kind" \
    | grep -o 'requested_bytes=[0-9]*' \
    | cut -d= -f2 \
    | sort -n | uniq -c || true
done

echo
echo "=== NATIVE SOURCE LAST 30 ==="
printf '%s\n' "$LOGS" \
  | grep 'media_source=direct_file' \
  | grep 'client_kind=native_media_source' \
  | tail -30 || true

echo
echo "=== LEGACY MEDIA BRIDGE LAST 30 ==="
printf '%s\n' "$LOGS" \
  | grep 'media_source=direct_file' \
  | grep 'client_kind=legacy_media_bridge' \
  | tail -30 || true

echo
echo "=== DISCONNECTS / BROKEN PIPE ==="
printf '%s\n' "$LOGS" \
  | grep -iE 'client_disconnected=true|broken pipe|connection reset' \
  | tail -50 || true

echo "===== END ====="
