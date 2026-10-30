#!/usr/bin/env bash
# Resolve a host-native, credential-safe Codex runtime. Only its path goes to stdout.
set -euo pipefail

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
version="0.164.0"
# Published from claymorelab/codex commit 27f7ff4d5c458953a9a54d48cc26ef93309cf8c9.

fail() {
  echo "Codex setup: $*" >&2
  exit 2
}

check_version() {
  local actual
  actual="$("$1" --version)" || fail "Cannot execute $1 on this host."
  case "$actual" in
    "codex-cli "*) ;;
    *) fail "Unexpected Codex version output from $1: $actual" ;;
  esac
  if [ -n "${2:-}" ] && [ "$actual" != "codex-cli $2" ]; then
    fail "Expected codex-cli $2, got: $actual"
  fi
  echo "Using $actual: $1" >&2
}

# An explicitly supplied runtime is operator-managed; never replace it or fall
# back to an unrelated Codex executable on PATH (including the stock SDK binary).
if [ -n "${CODEX_BIN:-}" ]; then
  binary="$CODEX_BIN"
  case "$binary" in '~/'*) binary="$HOME/${binary#\~/}" ;; esac
  [ -f "$binary" ] && [ -x "$binary" ] || fail "CODEX_BIN is not an executable file: $binary"
  binary="$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")"
  check_version "$binary"
  echo "Custom CODEX_BIN must include the DramaClaw credential-safety patches." >&2
  printf '%s\n' "$binary"
  exit 0
fi

system="$(uname -s)"
arch="$(uname -m)"
case "$system/$arch" in
  Darwin/arm64|Darwin/aarch64)
    target=aarch64-apple-darwin
    sha256=2f88642dc43dd758f243a8a7bde74d848c4180c3b6929f8891bad03060301a47
    ;;
  Darwin/x86_64)
    target=x86_64-apple-darwin
    sha256=83555e47dd6f255f473f507f92160156f727d79e3cf805f299ff994b48dd8937
    ;;
  Linux/x86_64)
    target=x86_64-unknown-linux-musl
    sha256=628f9923b2fe26f15b0aff80d778bdc3b005ea17079f6de5b5f6cd0fa7591e38
    ;;
  Linux/aarch64|Linux/arm64)
    target=aarch64-unknown-linux-musl
    sha256=34ab0569195d57b7042e40775793053cf3f337916d8059514d7c96e5d11ea385
    ;;
  *) fail "No published runtime for $system/$arch. Use Docker or a supported macOS/Linux host (Windows: WSL2)." ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is required to verify downloads."
fi

runtime_dir="${NOVELVIDEO_RUNTIME_DIR:-${NOVELVIDEO_DATA_ROOT:-$root_dir}/runtime}"
cache_dir="$runtime_dir/codex/bin/$version/$target/$sha256"
mkdir -p "$cache_dir"
cache_dir="$(cd "$cache_dir" && pwd)"
binary="$cache_dir/codex"

if [ -f "$binary" ] && [ "$(checksum "$binary")" = "$sha256" ]; then
  chmod 700 "$binary"
  check_version "$binary" "$version"
  printf '%s\n' "$binary"
  exit 0
fi

command -v curl >/dev/null 2>&1 || fail "curl is required to download Codex."
url="https://dramaclaw-dl.cdnfg.com/build/codex/$version/$target/$sha256/codex"
echo "Downloading Codex $version for $target (about 250–310 MB on first use)..." >&2
download_path="$(mktemp "$cache_dir/.download.XXXXXX")"
trap 'rm -f -- "$download_path"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if ! curl --fail --location --show-error --silent \
  --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 600 \
  --retry 2 --retry-max-time 1200 --output "$download_path" "$url"; then
  fail "Download failed; no runtime was installed. Retry or set CODEX_BIN to an existing patched runtime."
fi
[ "$(checksum "$download_path")" = "$sha256" ] || fail "SHA256 mismatch; refusing to execute the download."
chmod 700 "$download_path"
check_version "$download_path" "$version"
# A failed/interrupted download never replaces the cache. Concurrent launches
# may download twice, but only identical, verified bytes can reach this path.
mv -f "$download_path" "$binary"
printf '%s\n' "$binary"
