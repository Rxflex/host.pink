package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestParseRepo(t *testing.T) {
	cases := map[string][2]string{
		"owner/name":                                      {"owner/name", ""},
		"github.com/owner/name":                           {"owner/name", ""},
		"https://github.com/owner/name.git":               {"owner/name", ""},
		"https://github.com/redstone-md/hostpink-registy": {"redstone-md/hostpink-registy", ""},
		"owner/name@v1.2":                                 {"owner/name", "v1.2"},
	}
	for in, want := range cases {
		repo, ref, err := parseRepo(in)
		if err != nil || repo != want[0] || ref != want[1] {
			t.Errorf("parseRepo(%q) = %q, %q, %v; want %q, %q", in, repo, ref, err, want[0], want[1])
		}
	}
	if _, _, err := parseRepo("просто текст"); err == nil {
		t.Error("ждали ошибку на мусоре")
	}
}

func testPlugin() Plugin {
	return Plugin{
		ID: "yabs", Title: "YABS", Repo: "masonr/yet-another-bench-script",
		Ref:     "316260707a0db8ccd83d7f5ac9d643f21396b44c",
		Files:   []PFile{{Path: "yabs.sh", SHA256: strings.Repeat("0", 64)}},
		Actions: []Action{{ID: "run", Title: "run", Run: "bash yabs.sh"}},
	}
}

func TestValidPlugin(t *testing.T) {
	p := testPlugin()
	if err := validPlugin(p); err != nil {
		t.Fatal(err)
	}
	bad := p
	bad.ID = "../../etc"
	if validPlugin(bad) == nil {
		t.Error("id с путём должен отклоняться")
	}
	bad = p
	bad.Ref = "main"
	if validPlugin(bad) == nil {
		t.Error("ветка вместо коммита должна отклоняться")
	}
	bad = p
	bad.Files = []PFile{{Path: "../x.sh", SHA256: strings.Repeat("0", 64)}}
	if validPlugin(bad) == nil {
		t.Error("путь с .. должен отклоняться")
	}
}

// Реестр по HTTPS: плагины получают префикс реестра, битые отбрасываются.
func TestRegistryLoad(t *testing.T) {
	good := testPlugin()
	broken := testPlugin()
	broken.ID, broken.Ref = "broken", "main"
	reg := registryFile{Version: 1, Name: "Тест", Plugins: []Plugin{good, broken}}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(reg)
	}))
	defer srv.Close()
	old := httpc
	httpc = srv.Client()
	defer func() { httpc = old }()

	tmp := t.TempDir()
	t.Setenv("APPDATA", tmp)
	t.Setenv("XDG_CONFIG_HOME", tmp)
	t.Setenv("HOME", tmp)

	r, err := addRegistry(srv.URL + "/hostpink-registry.json")
	if err != nil {
		t.Fatal(err)
	}
	if r.Name != "Тест" {
		t.Errorf("имя реестра %q", r.Name)
	}
	var f registryFile
	if err := getJSON(r.fileURL(), &f); err != nil {
		t.Fatal(err)
	}
	ok := 0
	for _, p := range f.Plugins {
		if validPlugin(p) == nil {
			ok++
		}
	}
	if ok != 1 {
		t.Errorf("валидных плагинов %d, ждали 1", ok)
	}
	if _, err := addRegistry(srv.URL + "/hostpink-registry.json"); err == nil {
		t.Error("повторное добавление должно отклоняться")
	}
}

// Настоящая скачка с GitHub: верный хэш проходит, подменённый — нет.
func TestEnsureFilesHash(t *testing.T) {
	if os.Getenv("HOSTPINK_NET_TEST") == "" {
		t.Skip("сетевой тест: HOSTPINK_NET_TEST=1")
	}
	tmp := t.TempDir()
	t.Setenv("LOCALAPPDATA", tmp)
	t.Setenv("XDG_CACHE_HOME", tmp)
	t.Setenv("HOME", tmp)

	p := testPlugin()
	if _, err := ensureFiles(p); err == nil || !strings.Contains(err.Error(), "хэш не совпал") {
		t.Fatalf("подменённый хэш должен ломать установку, err=%v", err)
	}
	b, err := getBytes("https://raw.githubusercontent.com/" + p.Repo + "/" + p.Ref + "/yabs.sh")
	if err != nil {
		t.Fatal(err)
	}
	p.Files[0].SHA256 = sumHex(b)
	dir, err := ensureFiles(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir + "/yabs.sh"); err != nil {
		t.Fatal(err)
	}
}
