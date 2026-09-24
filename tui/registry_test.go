package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Цепочка реестров: корень → a → b → c → d. Между a и b ещё цикл b → a.
// Ждём плагины корня, a, b и c (глубина 3), d уже не читается, цикл не зацикливает.
func TestRegistryChain(t *testing.T) {
	var srv *httptest.Server
	reg := func(id string, refs ...string) registryFile {
		p := testPlugin()
		p.ID, p.Title = "plug-"+id, "Плагин "+id
		f := registryFile{Version: 1, Name: id, Plugins: []Plugin{p}}
		for _, r := range refs {
			f.Registries = append(f.Registries, Registry{ID: r, Name: r, URL: srv.URL + "/" + r + ".json"})
		}
		return f
	}
	hits := map[string]int{}
	var mu sync.Mutex
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/"), ".json")
		mu.Lock()
		hits[name]++
		mu.Unlock()
		var f registryFile
		switch name {
		case "plugins":
			f = reg("root", "a")
		case "a":
			f = reg("a", "b")
		case "b":
			f = reg("b", "a", "c")
		case "c":
			f = reg("c", "d")
		case "d":
			f = reg("d")
		default:
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(f)
	}))
	defer srv.Close()

	oldC, oldS := httpc, site
	httpc, site = srv.Client(), srv.URL
	defer func() { httpc, site = oldC, oldS }()
	tmp := t.TempDir()
	for _, k := range []string{"APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "HOME"} {
		t.Setenv(k, tmp)
	}

	c := loadCatalog()
	got := map[string]bool{}
	for _, p := range c.Plugins {
		got[p.ID] = true
	}
	for _, want := range []string{"plug-root", "plug-a", "plug-b", "plug-c"} {
		if !got[want] {
			t.Errorf("нет %s, есть %v", want, got)
		}
	}
	if got["plug-d"] {
		t.Error("реестр d глубже maxDepth, его не должно быть")
	}
	if hits["a"] != 1 {
		t.Errorf("реестр a читали %d раз, цикл не отсечён", hits["a"])
	}
	for _, r := range c.Registries {
		if !r.Official {
			t.Errorf("%s подключён через корень, должен считаться официальным", r.ID)
		}
	}
}
