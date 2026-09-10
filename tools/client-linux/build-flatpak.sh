#!/usr/bin/env bash
# Build the Baia Cinghiala Flatpak by compiling from source INSIDE the
# sandbox (org.freedesktop.Sdk.Extension.node20 + rust-stable), so the
# resulting binary links against the Flatpak runtime's own glibc instead of
# whatever glibc happens to be on this build machine. This replaced an
# earlier approach that wrapped a .deb built on the host directly — that hit
# "GLIBC_2.39 not found" when the host's glibc (e.g. Fedora 43) was newer
# than the org.gnome.Platform//46 runtime's. See the comments at the top of
# flatpak/it.baia.cinghiala.yml and https://github.com/tauri-apps/tauri/issues/11210.
#
# Usage:
#   ./tools/client-linux/build-flatpak.sh
#   ./tools/client-linux/build-flatpak.sh --connector-endpoint https://... \
#       --server-fingerprint SHA256:...
#
# Requires: flatpak, flatpak-builder, and (all in --user scope, matching how
# this script invokes flatpak-builder — see tools/client-linux/README.md):
#   flatpak install --user org.gnome.Platform//49 org.gnome.Sdk//49 \
#     org.freedesktop.Sdk.Extension.node20 org.freedesktop.Sdk.Extension.rust-stable
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CONNECTOR_ENDPOINT=""
SERVER_FINGERPRINT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --connector-endpoint) CONNECTOR_ENDPOINT="$2"; shift 2 ;;
    --server-fingerprint) SERVER_FINGERPRINT="$2"; shift 2 ;;
    *) echo "Argomento sconosciuto: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$CONNECTOR_ENDPOINT" ] && [ -z "$SERVER_FINGERPRINT" ]; then
  echo "--server-fingerprint è obbligatorio insieme a --connector-endpoint." >&2
  exit 1
fi
if [ -z "$CONNECTOR_ENDPOINT" ] && [ -n "$SERVER_FINGERPRINT" ]; then
  echo "--connector-endpoint è obbligatorio insieme a --server-fingerprint." >&2
  exit 1
fi

command -v flatpak-builder >/dev/null 2>&1 || {
  echo "flatpak-builder non trovato. Vedi tools/client-linux/README.md per l'installazione." >&2
  exit 1
}

# flatpak-builder --user (usato sotto) risolve le dipendenze solo dai remote
# registrati in ambito utente — un remote "flathub" di sistema non basta e
# fallisce con "No remote refs found for 'flathub'".
flatpak remotes --user 2>/dev/null | grep -qw flathub || {
  echo "Remote 'flathub' non registrato in ambito utente. Esegui:" >&2
  echo "  flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo" >&2
  echo "  flatpak install --user flathub org.gnome.Platform//49 org.gnome.Sdk//49 \\" >&2
  echo "    org.freedesktop.Sdk.Extension.node20 org.freedesktop.Sdk.Extension.rust-stable" >&2
  exit 1
}

mkdir -p flatpak/.generated
generated_manifest="flatpak/.generated/it.baia.cinghiala.yml"

if [ -n "$CONNECTOR_ENDPOINT" ]; then
  echo "Build configurata per: $CONNECTOR_ENDPOINT"
  env_prefix="BAIA_CONNECTOR_ENDPOINT=\"$CONNECTOR_ENDPOINT\" BAIA_CONNECTOR_SERVER_FINGERPRINT=\"$SERVER_FINGERPRINT\" "
else
  echo "Build generica (nessun server precompilato: si configura al pairing)."
  env_prefix=""
fi
sed "s#__CONNECTOR_ENDPOINT_ENV_PREFIX__#${env_prefix}#" \
  flatpak/it.baia.cinghiala.yml > "$generated_manifest"

echo "== flatpak-builder (compila da sorgente nella sandbox: può richiedere diversi minuti) =="
flatpak-builder --force-clean --user --install-deps-from=flathub \
  build-dir "$generated_manifest"

echo ""
echo "Build completata in ./build-dir (repo locale non ancora creato)."
echo "Per installare e testare subito:"
echo "  flatpak-builder --user --install --force-clean build-dir $generated_manifest"
echo "  flatpak run it.baia.cinghiala"
echo "Per generare un repo/bundle distribuibile:"
echo "  flatpak-builder --repo=repo --force-clean build-dir $generated_manifest"
echo "  flatpak build-bundle repo baia-cinghiala.flatpak it.baia.cinghiala"
