#!/bin/sh
# Установщик hostpink: curl -fsSL host.pink/tui | sh
# Скачивает бинарник под твою ОС и архитектуру, сверяет SHA-256 и запускает.
# Исходники: https://github.com/Rxflex/host.pink/tree/main/tui
set -eu

SITE="${HOSTPINK_SITE:-https://host.pink}"
pink() { printf '\033[38;5;205m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  FreeBSD) os=freebsd ;;
  *) die "не знаю такую ОС: $(uname -s). На Windows: irm host.pink/tui | iex" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  armv7*|armv6*|armhf) arch=arm ;;
  *) die "не знаю такую архитектуру: $(uname -m)" ;;
esac
name="hostpink-$os-$arch"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "нужен curl или wget"
fi

if [ "$(id -u)" = 0 ]; then
  dest=/usr/local/bin
else
  dest="$HOME/.local/bin"
fi
mkdir -p "$dest"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pink "host.pink → $name"
fetch "$SITE/dl/$name" "$tmp/hostpink" || die "не скачался $SITE/dl/$name"
fetch "$SITE/dl/SHA256SUMS" "$tmp/SHA256SUMS" || die "не скачались контрольные суммы"

want="$(grep " $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/hostpink" | cut -d' ' -f1)"
else
  got="$(shasum -a 256 "$tmp/hostpink" | cut -d' ' -f1)"
fi
[ -n "$want" ] && [ "$want" = "$got" ] || die "контрольная сумма не совпала, ставить не буду"
dim "SHA-256 совпал: $got"

chmod +x "$tmp/hostpink"
mv "$tmp/hostpink" "$dest/hostpink"
pink "✓ установлен в $dest/hostpink"

case ":$PATH:" in
  *":$dest:"*) ;;
  *) dim "Добавь $dest в PATH: echo 'export PATH=\"$dest:\$PATH\"' >> ~/.profile" ;;
esac

# stdin занят пайпом от curl, поэтому интерфейс берёт терминал напрямую
if [ -r /dev/tty ] && [ -z "${HOSTPINK_NO_RUN:-}" ]; then
  exec "$dest/hostpink" "$@" </dev/tty
fi
dim "Запуск: hostpink"
