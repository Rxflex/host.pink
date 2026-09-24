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
	settle := func(m *app) {
		m.tSp, m.fSp, m.lSp = spring{pos: float64(m.tSel)}, spring{pos: float64(m.fSel)}, spring{pos: float64(m.lSel)}
	}
	cat := loadCatalog()
	me := &myIP{IP: "203.0.113.7", ASN: 64500, Country: "NL"}
	mk := func(w, h int) *app {
		m := newApp(false)
		m.Update(tea.WindowSizeMsg{Width: w, Height: h})
		m.me, m.cat, m.scr = me, &cat, sHome
		m.omni.Focus()
		return m
	}

	m := mk(110, 36)
	m.start = time.Now().Add(-700 * time.Millisecond)
	m.scr, m.frame = sSplash, 40
	save("1-splash", m)

	m = mk(110, 36)
	m.frame = 80
	m.omni.SetValue("решала")
	save("2-home-omni", m)

	m = mk(110, 30)
	m.zone, m.fSel, m.frame = zFeat, 1, 80
	m.omni.Blur()
	settle(m)
	save("2b-home-feat", m)

	m = mk(80, 24)
	m.zone, m.tSel = zTools, 2
	m.omni.Blur()
	settle(m)
	save("2c-home-80x24", m)

	m = mk(120, 32)
	m.scr, m.lSel, m.frame = sPlugins, 1, 80
	settle(m)
	save("3-plugins", m)

	m.filter.SetValue("бэкап")
	m.lSel = 0
	settle(m)
	save("3b-plugins-filter", m)

	m.filter.SetValue("")
	m.pFocus, m.lSel = 1, 0
	settle(m)
	save("4-plugin-actions", m)

	req, _ := http.NewRequest("GET", "https://host.pink/1.1.1.1?text", nil)
	req.Header.Set("User-Agent", "curl/8.5")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	m = mk(110, 32)
	m.Update(textMsg{title: "Досье · 1.1.1.1", body: string(b)})
	m.scr, m.back, m.cur = sResult, sHome, tools[0]
	save("5-result", m)

	m = mk(110, 32)
	m.cur, m.inMode = tools[0], "tool"
	m.in.Placeholder = tools[0].placeholder
	m.scr = sInput
	m.in.Focus()
	save("6-input", m)
}
