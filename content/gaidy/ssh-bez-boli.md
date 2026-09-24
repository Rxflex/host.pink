---
title: "SSH без боли: ключи, конфиг и тишина в логах"
lede: "Пароли — для почты. На сервер заходят по ключу, root не пускают по паролю, а боты идут лесом."
category: server
weight: 2
actual: "OpenSSH 9.x, Ubuntu 24.04 / Debian 12"
lastmod: 2026-09-24
---

Если в `journalctl -u ssh` у тебя тысячи строк `Failed password for root`, поздравляем: сервер в интернете. Боты перебирают пароли круглосуточно. Задача не спрятаться от них, а сделать перебор бессмысленным.

## Ключ

На своей машине, не на сервере:

```bash
ssh-keygen -t ed25519 -C "me@laptop"
```

Ed25519 короче и быстрее RSA и поддерживается всеми современными серверами. Пароль на ключ ставь: утёкший ноутбук без пароля на ключе — это утёкшие серверы.

Закинуть ключ на сервер:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@203.0.113.10
```

Зайди по ключу и убедись, что пароль не спросили. **Только после этого** переходи к следующему шагу.

## Конфиг

Не правь `/etc/ssh/sshd_config` напрямую: при обновлении пакета появится конфликт. Кладём свой файл в `sshd_config.d`:

```ini {name="/etc/ssh/sshd_config.d/10-hardening.conf"}
PasswordAuthentication no
# в старых конфигах это ChallengeResponseAuthentication — теперь устаревший алиас
KbdInteractiveAuthentication no
# это и так дефолт OpenSSH, но пусть будет явно
PermitRootLogin prohibit-password
PubkeyAuthentication yes

MaxAuthTries 3
LoginGraceTime 20
ClientAliveInterval 60
ClientAliveCountMax 3

X11Forwarding no
AllowAgentForwarding no
```

> [!WARNING]
> Проверь, не переопределяет ли что-то твои настройки. cloud-init кладёт `50-cloud-init.conf` со своим `PasswordAuthentication`, если в облачном конфиге задан `ssh_pwauth`. Для большинства ключей sshd берёт **первое** полученное значение, `Include /etc/ssh/sshd_config.d/*.conf` в Debian и Ubuntu стоит в начале `sshd_config`, а файлы из маски подключаются в лексическом порядке. Поэтому наш `10-` важнее их `50-` и важнее основного конфига.

Проверить синтаксис и итоговые значения:

```bash
sshd -t && sshd -T | grep -Ei 'passwordauth|permitroot|kbdinteractive'
```

Применить, не закрывая текущую сессию:

```bash
systemctl reload ssh
```

Открой **второй** терминал и зайди заново. Зашёл — можно закрывать первый.

## Сменить порт

Смена порта не защищает от целенаправленной атаки, но убирает из логов основную массу мусора от ботов, которые стучатся только на 22. Это приятно.

```ini {name="/etc/ssh/sshd_config.d/10-hardening.conf"}
Port 22022
```

> [!IMPORTANT]
> В Ubuntu 24.04 (как и с 22.10) SSH по умолчанию запускается через `ssh.socket`. Порт и адрес для сокета берёт генератор `sshd-socket-generator` из конфига sshd, а генераторы запускаются при `daemon-reload`. После смены порта нужны две команды: `systemctl daemon-reload` и `systemctl restart ssh.socket`. В Debian 12 socket activation по умолчанию нет, там хватит `systemctl restart ssh`. Не забудь открыть новый порт в файрволе **до** перезапуска.

## Боты: fail2ban или CrowdSec

С ключами перебор паролей бесполезен, но боты всё равно жрут CPU на рукопожатиях и засоряют логи. Варианты:

- **Лимит в файрволе.** Самое дешёвое: не больше 10 новых соединений в минуту с одного адреса. Готовое правило есть в гайде [nftables: минимальный файрвол](/gaidy/nftables-minimalnyy-fayrvol/).
- **fail2ban.** Читает логи и банит после N неудач. Старый, простой, работает.
- **CrowdSec.** То же самое плюс общий список злодеев, которых уже поймали на других серверах.

## Удобство на своей стороне

Чтобы не набирать адрес и порт каждый раз:

```ini {name="~/.ssh/config"}
Host node-fra
  HostName 203.0.113.10
  Port 22022
  User root
  IdentityFile ~/.ssh/id_ed25519
```

Теперь `ssh node-fra` и всё. Как у людей.

## Источники

- [sshd_config(5)](https://man7.org/linux/man-pages/man5/sshd_config.5.html): «первое полученное значение», `Include` (лексический порядок), `PasswordAuthentication`, `KbdInteractiveAuthentication` (алиас `ChallengeResponseAuthentication`), `PermitRootLogin` (дефолт `prohibit-password`), `MaxAuthTries`, `LoginGraceTime`, `ClientAliveInterval`, `ClientAliveCountMax`, `X11Forwarding`, `AllowAgentForwarding`, `Port`
- [sshd(8)](https://man7.org/linux/man-pages/man8/sshd.8.html): `-t`, `-T`, перечитывание конфига по SIGHUP
- [ssh-keygen(1)](https://man7.org/linux/man-pages/man1/ssh-keygen.1.html), [ssh-copy-id(1)](https://man7.org/linux/man-pages/man1/ssh-copy-id.1.html), [ssh_config(5)](https://man7.org/linux/man-pages/man5/ssh_config.5.html)
- Ubuntu: [SSHd now uses socket-based activation (Ubuntu 22.10 and later)](https://discourse.ubuntu.com/t/sshd-now-uses-socket-based-activation-ubuntu-22-10-and-later/30189), [README.Debian пакета openssh (noble)](https://git.launchpad.net/ubuntu/+source/openssh/tree/debian/README.Debian?h=ubuntu/noble-updates): `sshd-socket-generator`, `daemon-reload` + `restart ssh.socket`; [README.Debian пакета openssh в Debian 12](https://sources.debian.org/src/openssh/1:9.2p1-2+deb12u7/debian/README.Debian/): socket activation только по желанию
- [Ubuntu Server: OpenSSH server](https://ubuntu.com/server/docs/how-to/security/openssh-server/): `Include /etc/ssh/sshd_config.d/*.conf` в начале `sshd_config`
- cloud-init: [ssh_util.py](https://github.com/canonical/cloud-init/blob/main/cloudinit/ssh_util.py) (`sshd_config.d/50-cloud-init.conf`), [cc_set_passwords](https://github.com/canonical/cloud-init/blob/main/cloudinit/config/cc_set_passwords.py) (`ssh_pwauth`)
