package main

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func binaryName() string {
	name := fmt.Sprintf("hostpink-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

func latestVersion() (string, error) {
	b, err := getBytes(site + "/dl/version.txt")
	return strings.TrimSpace(string(b)), err
}

// selfUpdate скачивает свежий бинарник с host.pink, сверяет SHA256SUMS и подменяет себя.
func selfUpdate(force bool) (string, error) {
	latest, err := latestVersion()
	if err != nil {
		return "", err
	}
	if latest == version && !force {
		return "У тебя последняя версия " + version + ".", nil
	}
	sums, err := getBytes(site + "/dl/SHA256SUMS")
	if err != nil {
		return "", err
	}
	want := ""
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == binaryName() {
			want = f[0]
		}
	}
	if want == "" {
		return "", fmt.Errorf("для %s/%s сборки нет", runtime.GOOS, runtime.GOARCH)
	}
	bin, err := getBytes(site + "/dl/" + binaryName())
	if err != nil {
		return "", err
	}
	if sumHex(bin) != want {
		return "", fmt.Errorf("контрольная сумма не совпала, обновление отменено")
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	tmp := exe + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return "", fmt.Errorf("нет прав записать %s: %w (попробуй через sudo)", tmp, err)
	}
	if runtime.GOOS == "windows" {
		// запущенный exe на Windows нельзя перезаписать, но можно переименовать
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return "", err
		}
	}
	if err := os.Rename(tmp, exe); err != nil {
		return "", err
	}
	return fmt.Sprintf("Обновлено: %s → %s. Перезапусти hostpink.", version, latest), nil
}

// cleanupOld убирает exe.old после обновления на Windows.
func cleanupOld() {
	if runtime.GOOS != "windows" {
		return
	}
	if exe, err := os.Executable(); err == nil {
		_ = os.Remove(exe + ".old")
	}
}
