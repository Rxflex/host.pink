package main

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

// Снимки экранов для визуальной проверки: HOSTPINK_SNAP=каталог go test -run TestSnapshots
func TestSnapshots(t *testing.T) {
	dir := os.Getenv("HOSTPINK_SNAP")
	if dir == "" {
		t.Skip("HOSTPINK_SNAP не задан")
	}
	save := func(name string, m *app) {
		_ = os.WriteFile(filepath.Join(dir, name+".ans"), []byte(m.View().Content), 0o644)
	}
	m := newApp(false)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 34})
	m.start = time.Now().Add(-700 * time.Millisecond)
	m.frame = 40
	save("1-splash", m)

	m.me = &myIP{IP: "203.0.113.7", ASN: 64500, Country: "NL"}
	m.toMenu()
	m.sel, m.pos, m.frame = 2, 2, 80
	save("2-menu", m)

	small := newApp(false)
	small.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	small.me, small.scr, small.sel, small.pos = m.me, sMenu, 4, 4
	save("2b-menu-80x24", small)

	c := loadCatalog()
	m.cat = &c
	m.scr, m.pSel, m.ppos = sPlugins, 2, 2
	save("3-plugins", m)

	p, _ := findPlugin(c, "reshala")
	m.plug, m.scr = p, sPlugin
	save("4-plugin", m)

	req, _ := http.NewRequest("GET", "https://host.pink/1.1.1.1?text", nil)
	req.Header.Set("User-Agent", "curl/8.5")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	m.Update(textMsg{title: "Досье · 1.1.1.1", body: string(b)})
	m.scr, m.back, m.cur = sResult, sMenu, menu[1]
	save("5-result", m)

	m.cur, m.inMode = menu[1], "tool"
	m.in.Placeholder = menu[1].placeholder
	m.scr = sInput
	m.in.Focus()
	save("6-input", m)
}
