package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/BurntSushi/toml"
)

// Плагин: чужой скрипт из git, закреплённый на коммите. Каждый файл скачивается по
// неизменяемому адресу raw.githubusercontent.com/<repo>/<commit>/<path> и сверяется по SHA-256.
type PFile struct {
	Path   string `json:"path" toml:"path"`
	SHA256 string `json:"sha256,omitempty" toml:"sha256"`
	Size   int    `json:"size,omitempty" toml:"size"`
}

type Action struct {
	ID    string `json:"id" toml:"id"`
	Title string `json:"title" toml:"title"`
	Run   string `json:"run" toml:"run"`
}

type Plugin struct {
	ID            string   `json:"id" toml:"id"`
	Title         string   `json:"title" toml:"title"`
	Author        string   `json:"author" toml:"author"`
	Repo          string   `json:"repo" toml:"repo"`
	Ref           string   `json:"ref" toml:"ref"`
	Category      string   `json:"category" toml:"category"`
	Description   string   `json:"description" toml:"description"`
	Platforms     []string `json:"platforms" toml:"platforms"`
	NeedsRoot     bool     `json:"needs_root" toml:"needs_root"`
	FetchesLatest bool     `json:"fetches_latest" toml:"fetches_latest"`
	Files         []PFile  `json:"files" toml:"files"`
	Actions       []Action `json:"actions" toml:"actions"`
	Source        string   `json:"source,omitempty" toml:"source"`

	// заполняется клиентом
	Registry string `json:"registry,omitempty" toml:"-"` // откуда плагин: host.pink, id реестра или git
	Trust    string `json:"trust,omitempty" toml:"-"`    // official | registry | user
}

// Key — уникальное имя плагина с учётом источника: reshala, redstone/foo, git/bar.
func (p Plugin) Key() string {
	if p.Trust == "official" || p.Registry == "" {
		return p.ID
	}
	return p.Registry + "/" + p.ID
}

func (p Plugin) Supported() bool {
	for _, x := range p.Platforms {
		if x == runtime.GOOS {
			return true
		}
	}
	return false
}

type Registry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Repo        string `json:"repo,omitempty"` // owner/name на GitHub
	URL         string `json:"url,omitempty"`  // или прямой адрес JSON
	Description string `json:"description,omitempty"`
	Official    bool   `json:"-"`
}

func (r Registry) fileURL() string {
	if r.URL != "" {
		return r.URL
	}
	return "https://raw.githubusercontent.com/" + r.Repo + "/HEAD/hostpink-registry.json"
}

// Официальный реестр: github.com/Rxflex/hostpink-registry, зеркало — host.pink/plugins.json.
const officialRegistryURL = "https://raw.githubusercontent.com/Rxflex/hostpink-registry/HEAD/hostpink-registry.json"

type registryFile struct {
	Version int      `json:"version"`
	Name    string   `json:"name"`
	Plugins []Plugin `json:"plugins"`
}

func configDir() string {
	d, err := os.UserConfigDir()
	if err != nil {
		d = os.TempDir()
	}
	return filepath.Join(d, "hostpink")
}

func cacheDir() string {
	d, err := os.UserCacheDir()
	if err != nil {
		d = os.TempDir()
	}
	return filepath.Join(d, "hostpink")
}

// ---------- реестры ----------

func userRegistries() []Registry {
	var list []Registry
	b, err := os.ReadFile(filepath.Join(configDir(), "registries.json"))
	if err == nil {
		_ = json.Unmarshal(b, &list)
	}
	return list
}

func saveUserRegistries(list []Registry) error {
	if err := os.MkdirAll(configDir(), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(list, "", "  ")
	return os.WriteFile(filepath.Join(configDir(), "registries.json"), b, 0o644)
}

var repoRe = regexp.MustCompile(`^(?:https?://)?(?:www\.)?(?:github\.com/)?([\w.-]+)/([\w.-]+?)(?:\.git)?/?(?:@([\w./-]+))?$`)

// parseRepo понимает owner/name, github.com/owner/name, https://github.com/owner/name и @ref в конце.
func parseRepo(s string) (repo, ref string, err error) {
	m := repoRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return "", "", fmt.Errorf("не понял адрес репозитория %q: нужен вид owner/name или github.com/owner/name", s)
	}
	return m[1] + "/" + m[2], m[3], nil
}

func addRegistry(spec string) (Registry, error) {
	var r Registry
	if strings.HasPrefix(spec, "https://") && strings.HasSuffix(spec, ".json") {
		r = Registry{URL: spec}
	} else {
		repo, _, err := parseRepo(spec)
		if err != nil {
			return r, err
		}
		r = Registry{Repo: repo}
	}
	var f registryFile
	if err := getJSON(r.fileURL(), &f); err != nil {
		return r, fmt.Errorf("не нашёл hostpink-registry.json: %w", err)
	}
	r.Name = f.Name
	if r.Repo != "" {
		r.ID = strings.ToLower(strings.SplitN(r.Repo, "/", 2)[0])
	} else {
		r.ID = "url" + shortHash(r.URL)
	}
	if r.Name == "" {
		r.Name = r.ID
	}
	list := userRegistries()
	for _, x := range list {
		if x.ID == r.ID {
			return r, fmt.Errorf("реестр %s уже добавлен", r.ID)
		}
	}
	return r, saveUserRegistries(append(list, r))
}

func removeRegistry(id string) error {
	list := userRegistries()
	out := list[:0]
	found := false
	for _, x := range list {
		if x.ID == id {
			found = true
			continue
		}
		out = append(out, x)
	}
	if !found {
		return fmt.Errorf("реестра %s нет среди добавленных тобой", id)
	}
	return saveUserRegistries(out)
}

// ---------- каталог ----------

type Catalog struct {
	Plugins    []Plugin
	Registries []Registry
	Notes      []string // что не загрузилось
}

// allRegistries: официальные реестры с host.pink плюс подключённые пользователем.
func allRegistries() []Registry {
	var list struct {
		Registries []Registry `json:"registries"`
	}
	_ = getJSON(site+"/registries.json", &list)
	var out []Registry
	for _, r := range list.Registries {
		r.Official = true
		out = append(out, r)
	}
	return append(out, userRegistries()...)
}

// loadCatalog собирает плагины из каталога host.pink, официальных реестров, реестров
// пользователя и плагинов, добавленных из git напрямую. Недоступный источник не ломает остальные.
func loadCatalog() Catalog {
	var c Catalog
	var mu sync.Mutex
	add := func(ps []Plugin) {
		mu.Lock()
		c.Plugins = append(c.Plugins, ps...)
		mu.Unlock()
	}
	note := func(s string) {
		mu.Lock()
		c.Notes = append(c.Notes, s)
		mu.Unlock()
	}

	var official registryFile
	cachePath := filepath.Join(cacheDir(), "plugins.json")
	err := getJSON(site+"/plugins.json", &official)
	if err != nil {
		// зеркало на host.pink недоступно — идём прямо в реестр на GitHub
		err = getJSON(officialRegistryURL, &official)
	}
	if err != nil {
		if b, e := os.ReadFile(cachePath); e == nil && json.Unmarshal(b, &official) == nil {
			note("каталог host.pink недоступен, показываю сохранённую копию")
		} else {
			note("каталог host.pink недоступен: " + err.Error())
		}
	} else if b, e := json.Marshal(official); e == nil {
		_ = os.MkdirAll(cacheDir(), 0o755)
		_ = os.WriteFile(cachePath, b, 0o644)
	}
	for i := range official.Plugins {
		official.Plugins[i].Registry, official.Plugins[i].Trust = "host.pink", "official"
	}
	add(official.Plugins)

	regs := allRegistries()
	c.Registries = regs

	var wg sync.WaitGroup
	for _, r := range regs {
		wg.Add(1)
		go func(r Registry) {
			defer wg.Done()
			var f registryFile
			if err := getJSON(r.fileURL(), &f); err != nil {
				note(fmt.Sprintf("реестр %s недоступен", r.Name))
				return
			}
			var ok []Plugin
			for _, p := range f.Plugins {
				if err := validPlugin(p); err != nil {
					note(fmt.Sprintf("%s/%s пропущен: %v", r.ID, p.ID, err))
					continue
				}
				p.Registry, p.Trust = r.ID, "registry"
				ok = append(ok, p)
			}
			add(ok)
		}(r)
	}
	wg.Wait()
	add(userPlugins())

	sort.SliceStable(c.Plugins, func(i, j int) bool {
		a, b := c.Plugins[i], c.Plugins[j]
		if rank(a) != rank(b) {
			return rank(a) < rank(b)
		}
		if a.Category != b.Category {
			return a.Category < b.Category
		}
		return strings.ToLower(a.Title) < strings.ToLower(b.Title)
	})
	sort.Strings(c.Notes)
	return c
}

func rank(p Plugin) int {
	switch p.Trust {
	case "official":
		return 0
	case "registry":
		return 1
	}
	return 2
}

var (
	shaRe = regexp.MustCompile(`^[0-9a-f]{40}$`)
	idRe  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)
)

func validPlugin(p Plugin) error {
	switch {
	case !idRe.MatchString(p.ID) || p.Title == "":
		return errors.New("id только из a-z, 0-9 и дефиса, нужен title")
	case !shaRe.MatchString(p.Ref):
		return errors.New("не закреплён на коммите (ref)")
	case len(p.Files) == 0 || len(p.Actions) == 0:
		return errors.New("нет files или actions")
	}
	for _, f := range p.Files {
		if len(f.SHA256) != 64 {
			return fmt.Errorf("у %s нет sha256", f.Path)
		}
		if strings.Contains(f.Path, "..") || filepath.IsAbs(f.Path) {
			return fmt.Errorf("странный путь %s", f.Path)
		}
	}
	return nil
}

// ---------- плагины из git напрямую ----------

func userPlugins() []Plugin {
	var out []Plugin
	dir := filepath.Join(configDir(), "plugins")
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var p Plugin
		if json.Unmarshal(b, &p) == nil && validPlugin(p) == nil {
			p.Registry, p.Trust = "git", "user"
			out = append(out, p)
		}
	}
	return out
}

// addPlugin читает hostpink.toml из репозитория, закрепляет его на текущем коммите
// и запоминает хэши файлов: дальше любые изменения в репозитории будут видны.
func addPlugin(spec string) (Plugin, error) {
	var p Plugin
	repo, ref, err := parseRepo(spec)
	if err != nil {
		return p, err
	}
	if ref == "" || !shaRe.MatchString(ref) {
		ref, err = resolveCommit(repo, ref)
		if err != nil {
			return p, err
		}
	}
	raw := "https://raw.githubusercontent.com/" + repo + "/" + ref + "/"
	if b, err := getBytes(raw + "hostpink.toml"); err == nil {
		if _, err := toml.Decode(string(b), &p); err != nil {
			return p, fmt.Errorf("hostpink.toml с ошибкой: %w", err)
		}
	} else if b, err2 := getBytes(raw + "hostpink.json"); err2 == nil {
		if err := json.Unmarshal(b, &p); err != nil {
			return p, fmt.Errorf("hostpink.json с ошибкой: %w", err)
		}
	} else {
		return p, fmt.Errorf("в %s нет hostpink.toml: %w", repo, err)
	}
	p.Repo, p.Ref = repo, ref
	if p.Author == "" {
		p.Author = strings.SplitN(repo, "/", 2)[0]
	}
	if p.ID == "" {
		p.ID = strings.Trim(regexp.MustCompile(`[^a-z0-9-]+`).ReplaceAllString(strings.ToLower(strings.SplitN(repo, "/", 2)[1]), "-"), "-")
	}
	if len(p.Platforms) == 0 {
		p.Platforms = []string{"linux"}
	}
	for i, f := range p.Files {
		b, err := getBytes(raw + f.Path)
		if err != nil {
			return p, err
		}
		sum := sha256.Sum256(b)
		p.Files[i].SHA256, p.Files[i].Size = hex.EncodeToString(sum[:]), len(b)
		if looksLikeFetcher(string(b)) {
			p.FetchesLatest = true
		}
	}
	if err := validPlugin(p); err != nil {
		return p, err
	}
	dir := filepath.Join(configDir(), "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return p, err
	}
	b, _ := json.MarshalIndent(p, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, p.ID+".json"), b, 0o644); err != nil {
		return p, err
	}
	p.Registry, p.Trust = "git", "user"
	return p, nil
}

func removePlugin(id string) error {
	err := os.Remove(filepath.Join(configDir(), "plugins", id+".json"))
	if os.IsNotExist(err) {
		return fmt.Errorf("плагина %s нет среди добавленных из git", id)
	}
	return err
}

var fetchRe = regexp.MustCompile(`(?i)raw\.githubusercontent\.com|github\.com/[^\s"']+/(archive|raw|releases)|git clone|cdn\.jsdelivr\.net/gh`)

func looksLikeFetcher(s string) bool { return fetchRe.MatchString(s) }

func resolveCommit(repo, branch string) (string, error) {
	if branch == "" {
		var r struct {
			DefaultBranch string `json:"default_branch"`
		}
		if err := getJSON("https://api.github.com/repos/"+repo, &r); err != nil {
			return "", err
		}
		branch = r.DefaultBranch
	}
	var c struct {
		SHA string `json:"sha"`
	}
	if err := getJSON("https://api.github.com/repos/"+repo+"/commits/"+branch, &c); err != nil {
		return "", err
	}
	return c.SHA, nil
}

// ---------- установка и запуск ----------

func pluginDir(p Plugin) string {
	return filepath.Join(cacheDir(), "plugins", strings.ReplaceAll(p.Key(), "/", "_"), p.Ref[:12])
}

// ensureFiles скачивает файлы плагина на закреплённом коммите и проверяет SHA-256.
func ensureFiles(p Plugin) (string, error) {
	dir := pluginDir(p)
	for _, f := range p.Files {
		dst := filepath.Join(dir, filepath.FromSlash(f.Path))
		if b, err := os.ReadFile(dst); err == nil && sumHex(b) == f.SHA256 {
			continue
		}
		b, err := getBytes("https://raw.githubusercontent.com/" + p.Repo + "/" + p.Ref + "/" + f.Path)
		if err != nil {
			return "", err
		}
		if got := sumHex(b); got != f.SHA256 {
			return "", fmt.Errorf("%s: хэш не совпал (ждали %s…, пришло %s…). Файл подменён или реестр устарел, запуск отменён", f.Path, f.SHA256[:12], got[:12])
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(dst, b, 0o755); err != nil {
			return "", err
		}
	}
	return dir, nil
}

func readPluginFile(p Plugin, path string) (string, error) {
	dir, err := ensureFiles(p)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(path)))
	return string(b), err
}

func buildCmd(p Plugin, a Action, dir string) (*exec.Cmd, error) {
	if !p.Supported() {
		return nil, fmt.Errorf("плагин работает на %s, а здесь %s", strings.Join(p.Platforms, ", "), runtime.GOOS)
	}
	args := strings.Fields(a.Run)
	if len(args) == 0 {
		return nil, errors.New("пустая команда")
	}
	if p.NeedsRoot && runtime.GOOS != "windows" && os.Geteuid() != 0 {
		if _, err := exec.LookPath("sudo"); err != nil {
			return nil, errors.New("плагину нужен root, а sudo нет: запусти hostpink от root")
		}
		args = append([]string{"sudo", "-E"}, args...)
	}
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "HOSTPINK=1", "HOSTPINK_VERSION="+version)
	return cmd, nil
}

func findPlugin(c Catalog, key string) (Plugin, bool) {
	for _, p := range c.Plugins {
		if p.Key() == key || p.ID == key {
			return p, true
		}
	}
	return Plugin{}, false
}

func sumHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func shortHash(s string) string { return sumHex([]byte(s))[:8] }
