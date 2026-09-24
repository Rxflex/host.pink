// hostpink — терминальный клиент host.pink: сетевые тулзы, база знаний и плагины сообщества.
//
// Copyright (c) 2026 Rxflex (https://github.com/Rxflex, https://host.pink).
// PolyForm Noncommercial License 1.0.0, см. LICENSE.md в корне репозитория.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	tea "charm.land/bubbletea/v2"
)

var version = "dev"

// site можно подменить для разработки: HOSTPINK_SITE=http://127.0.0.1:8787
var site = func() string {
	if s := os.Getenv("HOSTPINK_SITE"); s != "" {
		return strings.TrimRight(s, "/")
	}
	return "https://host.pink"
}()

var prog *tea.Program

const helpText = `hostpink — host.pink в терминале

  hostpink                       открыть интерфейс
  hostpink plugins               список плагинов из каталога и реестров
  hostpink run <плагин> [действие]   запустить плагин без интерфейса
  hostpink add <github.com/owner/repo>   добавить плагин из git (нужен hostpink.toml)
  hostpink rm <плагин>           удалить плагин, добавленный из git
  hostpink registry              список реестров
  hostpink registry add <github.com/owner/repo>   подключить сторонний реестр
  hostpink registry rm <id>      отключить свой реестр
  hostpink update                обновиться
  hostpink version

  --no-anim   без анимаций (или переменная HOSTPINK_NO_ANIM=1; NO_COLOR тоже выключает)
`

func main() {
	noAnim := os.Getenv("HOSTPINK_NO_ANIM") != "" || os.Getenv("NO_COLOR") != ""
	var args []string
	for _, a := range os.Args[1:] {
		if a == "--no-anim" {
			noAnim = true
		} else {
			args = append(args, a)
		}
	}
	if len(args) > 0 {
		if err := cli(args); err != nil {
			fmt.Fprintln(os.Stderr, "✗", err)
			os.Exit(1)
		}
		return
	}
	prog = tea.NewProgram(newApp(noAnim))
	if _, err := prog.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "✗", err)
		os.Exit(1)
	}
}

func cli(args []string) error {
	switch args[0] {
	case "version", "-v", "--version":
		fmt.Println("hostpink", version)
	case "help", "-h", "--help":
		fmt.Print(helpText)
	case "update":
		msg, err := selfUpdate(len(args) > 1 && args[1] == "--force")
		if err != nil {
			return err
		}
		fmt.Println(msg)
	case "plugins", "list", "ls":
		c := loadCatalog()
		for _, p := range c.Plugins {
			tag := ""
			if !p.Supported() {
				tag = " [" + strings.Join(p.Platforms, "/") + "]"
			}
			if p.NeedsRoot {
				tag += " [root]"
			}
			fmt.Printf("%-32s %s%s\n", p.Key(), p.Title, tag)
		}
		for _, n := range c.Notes {
			fmt.Fprintln(os.Stderr, "·", n)
		}
	case "run":
		if len(args) < 2 {
			return errors.New("какой плагин? hostpink plugins покажет список")
		}
		p, ok := findPlugin(loadCatalog(), args[1])
		if !ok {
			return fmt.Errorf("плагина %s нет", args[1])
		}
		a := p.Actions[0]
		if len(args) > 2 {
			found := false
			for _, x := range p.Actions {
				if x.ID == args[2] {
					a, found = x, true
				}
			}
			if !found {
				return fmt.Errorf("у %s нет действия %s", p.ID, args[2])
			}
		}
		dir, err := ensureFiles(p)
		if err != nil {
			return err
		}
		cmd, err := buildCmd(p, a, dir)
		if err != nil {
			return err
		}
		fmt.Printf("▶ %s: %s (github.com/%s @ %s)\n", p.Title, a.Run, p.Repo, p.Ref[:7])
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				os.Exit(ee.ExitCode())
			}
			return err
		}
	case "add":
		if len(args) < 2 {
			return errors.New("откуда? hostpink add github.com/owner/repo")
		}
		p, err := addPlugin(args[1])
		if err != nil {
			return err
		}
		fmt.Printf("✓ %s добавлен, закреплён на %s. Запуск: hostpink run git/%s\n", p.Title, p.Ref[:7], p.ID)
	case "rm", "remove":
		if len(args) < 2 {
			return errors.New("какой плагин удалить?")
		}
		if err := removePlugin(strings.TrimPrefix(args[1], "git/")); err != nil {
			return err
		}
		fmt.Println("✓ удалён")
	case "registry", "registries":
		if len(args) == 1 {
			for _, r := range allRegistries() {
				kind := "свой"
				if r.Official {
					kind = "корневой→" + r.Via
				}
				fmt.Printf("%-16s %-12s %s\n", r.ID, kind, r.Repo+r.URL)
			}
			return nil
		}
		switch args[1] {
		case "add":
			if len(args) < 3 {
				return errors.New("hostpink registry add github.com/owner/repo")
			}
			r, err := addRegistry(args[2])
			if err != nil {
				return err
			}
			fmt.Printf("✓ реестр %s (%s) подключён\n", r.Name, r.ID)
		case "rm", "remove":
			if len(args) < 3 {
				return errors.New("hostpink registry rm <id>")
			}
			if err := removeRegistry(args[2]); err != nil {
				return err
			}
			fmt.Println("✓ отключён")
		default:
			return fmt.Errorf("не знаю команду registry %s", args[1])
		}
	default:
		return fmt.Errorf("неизвестная команда %q\n\n%s", args[0], helpText)
	}
	return nil
}
