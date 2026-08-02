#!/usr/bin/env bash
# Builds the second Altium oracle.
#
# Clones AltiumSharp at a pinned commit into vendor/ and builds the dumper
# against it. Both are gitignored: this fetches a large tree and a .NET SDK's
# worth of build output, neither of which belongs in the repo.
#
# Requires the .NET SDK. If you do not have it:
#   curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0
# which installs to ~/.dotnet and touches nothing system-wide.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENDOR="$HERE/vendor/altiumsharp"

# Pinned. An oracle that silently changes under you is not an oracle.
COMMIT="ce72437f30cd54f549601d4e0ca5846d21272150"

if ! command -v dotnet >/dev/null 2>&1; then
  if [ -x "$HOME/.dotnet/dotnet" ]; then
    export PATH="$HOME/.dotnet:$PATH"
  else
    echo "The .NET SDK is not installed. See the header of this script." >&2
    exit 1
  fi
fi

if [ ! -d "$VENDOR/.git" ]; then
  echo "Cloning AltiumSharp at $COMMIT ..."
  mkdir -p "$(dirname "$VENDOR")"
  git clone --recurse-submodules https://github.com/issus/AltiumSharp.git "$VENDOR"
fi

git -C "$VENDOR" fetch --depth 50 origin "$COMMIT" 2>/dev/null || true
git -C "$VENDOR" checkout --quiet "$COMMIT"
git -C "$VENDOR" submodule update --init --recursive --quiet

echo "Building the oracle ..."
dotnet build "$HERE/altium-oracle.csproj" -c Release -v quiet --nologo

echo "Built: $HERE/bin/Release/net10.0/altium-oracle"
