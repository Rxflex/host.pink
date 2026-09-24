package main

import (
	"errors"
	"fmt"
	"image/color"
	"math"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/harmonica"
)

type screen int

const (
	sSplash screen = iota
	sHome
	sInput
	sResult
	sPlugins
	sPlugin
	sRegistries
	sExecDone
)

type zone int

const (
	zOmni zone = iota
	zTools
	zFeat
)

type item struct {
	id, key, title, desc string
	prompt, placeholder  string
	examples             string
	path                 func(string) string
}

var tools = []item{
	{id: "dossier", key: "d", title: "Досье", desc: "IP, домен, AS или префикс", prompt: "IP, домен, AS или префикс", placeholder: "1.1.1.1", examples: "8.8.8.8 · example.com · AS13335 · 1.1.1.0/24", path: func(s string) string { return "/" + pathArg(s) }},
	{id: "check", key: "c", title: "Доступность из РФ", desc: "домашние сети, ДЦ и мир", prompt: "Сайт или хост", placeholder: "example.com", examples: "youtube.com · твоя-панель.ru", path: func(s string) string { return "/check/" + pathArg(s) }},
	{id: "dns", key: "n", title: "DNS", desc: "все записи домена", prompt: "Домен", placeholder: "example.com", examples: "host.pink · github.com", path: func(s string) string { return "/dns/" + pathArg(s) }},
	{id: "ping", key: "t", title: "TCP-пинг", desc: "хост:порт с эджа Cloudflare", prompt: "Хост и порт", placeholder: "example.com:443", examples: "1.1.1.1:443 · твоя-нода:8443", path: func(s string) string { return "/ping/" + pathArg(s) }},
	{id: "ip", key: "i", title: "Мой IP", desc: "провайдер, AS и сеть", path: func(string) string { return "/ip" }},
	{id: "search", key: "s", title: "Поиск по базе", desc: "BedolagaBD и гайды", prompt: "Что ищем", placeholder: "reality selfsteal", examples: "xhttp · белые списки · бэкап remnawave", path: func(s string) string { return "/search?q=" + url.QueryEscape(s) }},
	{id: "ask", key: "a", title: "Спросить ИИ", desc: "ответ со ссылками на базу", prompt: "Вопрос", placeholder: "почему нода пингуется, но не работает?", examples: "что такое ТСПУ? · как сделать мост RU→EU?", path: func(s string) string { return "/ask?q=" + url.QueryEscape(s) }},
}

// сообщения
type frameMsg time.Time
type catalogMsg Catalog
type filesMsg struct {
	p   Plugin
	a   Action
	dir string
	err error
}
type execDoneMsg struct{ err error }
type textMsg struct {
	title, body string
	err         error
}
type addedMsg struct {
	p   *Plugin
	reg *Registry
	err error
}

type spring struct{ pos, vel float64 }

type app struct {
	w, h   int
	scr    screen
	noAnim bool
	frame  int
	start  time.Time
	sp     harmonica.Spring

	me *myIP

	// главный экран
	zone     zone
	omni     textinput.Model
	tSel     int
	fSel     int
	tSp, fSp spring

	// ввод для конкретного инструмента
	inMode string // tool | plugin | registry
	cur    item
	in     textinput.Model

	// результат
	vp       viewport.Model
	title    string
	body     strings.Builder
	loading  bool
	streamID int
	back     screen
	lastArg  string

	// плагины
	cat       *Catalog
	catLoad   bool
	filter    textinput.Model
	filtering bool
	lSel      int
	lSp       spring
	pFocus    int // 0 список, 1 действия
	aSel      int
	plug      Plugin
	rSel      int
	status    string
	execCode  int
	execErr   error
}

func newApp(noAnim bool) *app {
	mk := func(prompt string) textinput.Model {
		t := textinput.New()
		t.Prompt = prompt
		t.CharLimit = 300
		return t
	}
	omni := mk("")
	omni.Placeholder = "IP, домен, AS, вопрос или название плагина"
	vp := viewport.New(viewport.WithWidth(80), viewport.WithHeight(20))
	vp.SoftWrap = true
	flt := mk("/ ")
	flt.Placeholder = "фильтр"
	m := &app{
		scr: sSplash, noAnim: noAnim, start: time.Now(),
		sp:   harmonica.NewSpring(harmonica.FPS(60), 7.5, 0.72),
		omni: omni, in: mk("› "), filter: flt, vp: vp,
		w: 100, h: 30,
		tSp: spring{pos: -1}, fSp: spring{pos: -1}, lSp: spring{pos: -1},
	}
	return m
}

func tick() tea.Cmd {
	return tea.Tick(time.Second/60, func(t time.Time) tea.Msg { return frameMsg(t) })
}

func (m *app) Init() tea.Cmd {
	cleanupOld()
	m.catLoad = true
	cmds := []tea.Cmd{fetchIP(), loadCatalogCmd(), m.omni.Focus()}
	if m.noAnim {
		m.scr = sHome
		m.tSp, m.fSp, m.lSp = spring{}, spring{}, spring{}
	} else {
		cmds = append(cmds, tick())
	}
	return tea.Batch(cmds...)
}

func (s *spring) step(sp harmonica.Spring, target int) bool {
	s.pos, s.vel = sp.Update(s.pos, s.vel, float64(target))
	return math.Abs(s.pos-float64(target)) > 0.01 || math.Abs(s.vel) > 0.01
}

func (m *app) kick() tea.Cmd {
	if m.noAnim {
		return nil
	}
	return tick()
}

func (m *app) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		m.resize()
		return m, nil

	case frameMsg:
		m.frame++
		if m.scr == sSplash && time.Since(m.start) > 1500*time.Millisecond {
			m.scr = sHome
		}
		moving := m.tSp.step(m.sp, m.tSel)
		moving = m.fSp.step(m.sp, m.fSel) || moving
		moving = m.lSp.step(m.sp, m.lSel) || moving
		if m.scr == sSplash || moving || m.loading || m.catLoad || time.Since(m.start) < 5*time.Second {
			return m, tick()
		}
		return m, nil

	case ipMsg:
		m.me = msg.ip
		return m, nil

	case chunkMsg:
		if msg.id == m.streamID {
			m.body.WriteString(msg.data)
			m.vp.SetContent(m.body.String())
		}
		return m, nil

	case streamDoneMsg:
		if msg.id == m.streamID {
			m.loading = false
			if msg.err != nil {
				m.body.WriteString("\n" + sBad.Render("Ошибка: "+msg.err.Error()) + "\n")
				m.vp.SetContent(m.body.String())
			}
		}
		return m, nil

	case textMsg:
		m.loading = false
		m.title = msg.title
		m.body.Reset()
		if msg.err != nil {
			m.body.WriteString(sBad.Render("Ошибка: " + msg.err.Error()))
		} else {
			m.body.WriteString(msg.body)
		}
		m.vp.SetContent(m.body.String())
		m.vp.GotoTop()
		return m, nil

	case catalogMsg:
		c := Catalog(msg)
		m.cat, m.catLoad = &c, false
		m.clampPlugins()
		return m, nil

	case addedMsg:
		m.loading = false
		m.scr = sPlugins
		if msg.err != nil {
			m.status = sBad.Render("✗ " + msg.err.Error())
			return m, nil
		}
		if msg.p != nil {
			m.status = sOK.Render("✓ Добавлен " + msg.p.Title + ", закреплён на " + msg.p.Ref[:7])
		} else {
			m.status = sOK.Render("✓ Реестр " + msg.reg.Name + " подключён")
		}
		m.catLoad = true
		return m, tea.Batch(loadCatalogCmd(), m.kick())

	case filesMsg:
		m.loading = false
		if msg.err != nil {
			m.status = sBad.Render("✗ " + msg.err.Error())
			return m, nil
		}
		cmd, err := buildCmd(msg.p, msg.a, msg.dir)
		if err != nil {
			m.status = sBad.Render("✗ " + err.Error())
			return m, nil
		}
		m.status = ""
		return m, tea.ExecProcess(cmd, func(err error) tea.Msg { return execDoneMsg{err} })

	case execDoneMsg:
		m.scr, m.execErr, m.execCode = sExecDone, msg.err, 0
		var ee *exec.ExitError
		if errors.As(msg.err, &ee) {
			m.execCode = ee.ExitCode()
		}
		return m, nil

	case tea.KeyPressMsg:
		return m.key(msg)
	}

	var cmd tea.Cmd
	switch {
	case m.scr == sHome && m.zone == zOmni:
		m.omni, cmd = m.omni.Update(msg)
	case m.scr == sInput:
		m.in, cmd = m.in.Update(msg)
	case m.scr == sPlugins && m.filtering:
		m.filter, cmd = m.filter.Update(msg)
	case m.scr == sResult:
		m.vp, cmd = m.vp.Update(msg)
	}
	return m, cmd
}

func (m *app) resize() {
	w := m.pageWidth()
	m.omni.SetWidth(max(10, w-48))
	m.in.SetWidth(max(10, w-10))
	m.filter.SetWidth(24)
	m.vp.SetWidth(max(20, w-4))
	m.vp.SetHeight(max(5, m.h-7))
}

func (m *app) pageWidth() int { return max(40, min(m.w-2, 120)) }

// ---------- клавиши ----------

func (m *app) key(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	s := k.String()
	if s == "ctrl+c" {
		return m, tea.Quit
	}
	switch m.scr {
	case sSplash:
		m.scr = sHome
		return m, m.kick()
	case sHome:
		return m.keyHome(k, s)
	case sInput:
		return m.keyInput(k, s)
	case sResult:
		return m.keyResult(k, s)
	case sPlugins:
		return m.keyPlugins(k, s)
	case sPlugin:
		return m.keyPluginDetail(s)
	case sRegistries:
		return m.keyRegistries(s)
	case sExecDone:
		m.scr = sPlugins
		if m.narrow() {
			m.scr = sPlugin
		}
		return m, nil
	}
	return m, nil
}

func (m *app) keyHome(k tea.KeyPressMsg, s string) (tea.Model, tea.Cmd) {
	if m.zone == zOmni {
		switch s {
		case "enter":
			if p, ok := m.matchPlugin(m.omni.Value()); ok {
				m.omni.SetValue("")
				m.zone = zFeat
				m.omni.Blur()
				return m.openPlugin(p)
			}
			if r, ok := routeQuery(m.omni.Value()); ok {
				return m.run(r.it, r.arg)
			}
			return m, nil
		case "tab", "down":
			m.zone = zTools
			m.omni.Blur()
			return m, m.kick()
		case "esc":
			if m.omni.Value() == "" {
				m.zone = zTools
				m.omni.Blur()
			}
			m.omni.SetValue("")
			return m, nil
		}
		var cmd tea.Cmd
		m.omni, cmd = m.omni.Update(k)
		return m, cmd
	}

	feat := m.featured()
	switch s {
	case "q", "esc":
		return m, tea.Quit
	case "/", "shift+tab":
		m.zone = zOmni
		return m, m.omni.Focus()
	case "tab":
		switch m.zone {
		case zTools:
			if len(feat) > 0 {
				m.zone = zFeat
			} else {
				m.zone = zOmni
				return m, m.omni.Focus()
			}
		default:
			m.zone = zOmni
			return m, m.omni.Focus()
		}
		return m, m.kick()
	case "left", "h":
		m.zone = zTools
		return m, m.kick()
	case "right", "l":
		if len(feat) > 0 {
			m.zone = zFeat
		}
		return m, m.kick()
	case "up", "k":
		if m.zone == zTools {
			if m.tSel == 0 {
				m.zone = zOmni
				return m, m.omni.Focus()
			}
			m.tSel--
		} else if m.fSel > 0 {
			m.fSel--
		} else {
			m.zone = zOmni
			return m, m.omni.Focus()
		}
		return m, m.kick()
	case "down", "j":
		if m.zone == zTools {
			m.tSel = min(m.tSel+1, len(tools)-1)
		} else {
			m.fSel = min(m.fSel+1, len(feat)-1)
		}
		return m, m.kick()
	case "enter", "space":
		if m.zone == zTools {
			return m.open(tools[m.tSel])
		}
		if m.fSel < len(feat) {
			return m.openPlugin(feat[m.fSel])
		}
	case "p":
		return m.openPlugins()
	case "u":
		return m.update()
	}
	for i, t := range tools {
		if s == t.key {
			m.zone, m.tSel = zTools, i
			return m.open(t)
		}
	}
	return m, nil
}

func (m *app) keyInput(k tea.KeyPressMsg, s string) (tea.Model, tea.Cmd) {
	switch s {
	case "esc":
		if m.inMode == "tool" {
			m.scr = sHome
		} else {
			m.scr = sPlugins
		}
		return m, m.kick()
	case "enter":
		v := strings.TrimSpace(m.in.Value())
		if v == "" {
			return m, nil
		}
		switch m.inMode {
		case "plugin":
			m.loading, m.status = true, "Читаю hostpink.toml из "+v+"…"
			return m, tea.Batch(func() tea.Msg { p, err := addPlugin(v); return addedMsg{p: &p, err: err} }, m.kick())
		case "registry":
			m.loading, m.status = true, "Читаю реестр "+v+"…"
			return m, tea.Batch(func() tea.Msg { r, err := addRegistry(v); return addedMsg{reg: &r, err: err} }, m.kick())
		}
		return m.run(m.cur, v)
	}
	var cmd tea.Cmd
	m.in, cmd = m.in.Update(k)
	return m, cmd
}

func (m *app) keyResult(k tea.KeyPressMsg, s string) (tea.Model, tea.Cmd) {
	switch s {
	case "esc", "q", "backspace":
		m.streamID++
		m.loading = false
		m.scr = m.back
		return m, m.kick()
	case "r":
		if m.back == sHome && m.cur.path != nil {
			return m.run(m.cur, m.lastArg)
		}
	case "g", "home":
		m.vp.GotoTop()
		return m, nil
	case "G", "end":
		m.vp.GotoBottom()
		return m, nil
	}
	var cmd tea.Cmd
	m.vp, cmd = m.vp.Update(k)
	return m, cmd
}

func (m *app) keyPlugins(k tea.KeyPressMsg, s string) (tea.Model, tea.Cmd) {
	list := m.visiblePlugins()
	if m.filtering {
		switch s {
		case "esc":
			m.filtering = false
			m.filter.SetValue("")
			m.filter.Blur()
			m.clampPlugins()
			return m, nil
		case "enter", "down", "tab":
			m.filtering = false
			m.filter.Blur()
			return m, nil
		}
		var cmd tea.Cmd
		m.filter, cmd = m.filter.Update(k)
		m.lSel = 0
		return m, cmd
	}
	if m.pFocus == 1 && len(list) > 0 {
		p := list[m.lSel]
		switch s {
		case "up", "k":
			m.aSel = (m.aSel - 1 + len(p.Actions)) % len(p.Actions)
			return m, nil
		case "down", "j":
			m.aSel = (m.aSel + 1) % len(p.Actions)
			return m, nil
		case "left", "h", "esc", "tab":
			m.pFocus = 0
			return m, nil
		case "enter":
			return m.runPlugin(p, p.Actions[m.aSel])
		case "v":
			return m.viewCode(p)
		}
		return m, nil
	}
	switch s {
	case "esc", "q":
		if m.filter.Value() != "" {
			m.filter.SetValue("")
			m.lSel = 0
			return m, nil
		}
		m.scr, m.zone = sHome, zTools
		return m, m.kick()
	case "up", "k":
		if m.lSel > 0 {
			m.lSel--
		}
		m.aSel = 0
		return m, m.kick()
	case "down", "j":
		if m.lSel < len(list)-1 {
			m.lSel++
		}
		m.aSel = 0
		return m, m.kick()
	case "enter", "right", "l", "tab":
		if len(list) == 0 {
			return m, nil
		}
		if m.narrow() {
			m.plug, m.aSel, m.scr = list[m.lSel], 0, sPlugin
			return m, nil
		}
		m.pFocus, m.aSel = 1, 0
		return m, nil
	case "v":
		if len(list) > 0 {
			return m.viewCode(list[m.lSel])
		}
	case "/":
		m.filtering = true
		return m, m.filter.Focus()
	case "a":
		return m.ask("plugin", "Добавить плагин из git", "github.com/owner/repo")
	case "g":
		m.scr, m.rSel = sRegistries, 0
		return m, nil
	case "r":
		m.catLoad, m.status = true, ""
		return m, tea.Batch(loadCatalogCmd(), m.kick())
	case "d":
		if len(list) > 0 && list[m.lSel].Trust == "user" {
			return m.removeUserPlugin(list[m.lSel])
		}
	}
	return m, nil
}

func (m *app) keyPluginDetail(s string) (tea.Model, tea.Cmd) {
	p := m.plug
	switch s {
	case "esc", "q", "backspace", "left":
		m.scr, m.status = sPlugins, ""
		return m, m.kick()
	case "up", "k":
		m.aSel = (m.aSel - 1 + len(p.Actions)) % len(p.Actions)
	case "down", "j":
		m.aSel = (m.aSel + 1) % len(p.Actions)
	case "v":
		return m.viewCode(p)
	case "d":
		if p.Trust == "user" {
			return m.removeUserPlugin(p)
		}
	case "enter":
		return m.runPlugin(p, p.Actions[m.aSel])
	}
	return m, nil
}

func (m *app) keyRegistries(s string) (tea.Model, tea.Cmd) {
	regs := m.registries()
	switch s {
	case "esc", "q", "backspace":
		m.scr = sPlugins
		return m, m.kick()
	case "up", "k":
		if m.rSel > 0 {
			m.rSel--
		}
	case "down", "j":
		if m.rSel < len(regs)-1 {
			m.rSel++
		}
	case "a":
		return m.ask("registry", "Подключить реестр", "github.com/owner/hostpink-registry")
	case "d":
		if m.rSel < len(regs) && !regs[m.rSel].Official {
			if err := removeRegistry(regs[m.rSel].ID); err != nil {
				m.status = sBad.Render("✗ " + err.Error())
			} else {
				m.status, m.catLoad, m.rSel = sOK.Render("✓ Реестр отключён"), true, 0
				return m, loadCatalogCmd()
			}
		}
	}
	return m, nil
}

// ---------- действия ----------

func (m *app) open(it item) (tea.Model, tea.Cmd) {
	m.cur = it
	if it.prompt == "" {
		return m.run(it, "")
	}
	m.inMode = "tool"
	m.in.SetValue("")
	m.in.Placeholder = it.placeholder
	m.scr = sInput
	return m, m.in.Focus()
}

func (m *app) ask(mode, prompt, placeholder string) (tea.Model, tea.Cmd) {
	m.inMode = mode
	m.cur = item{title: prompt, prompt: prompt, placeholder: placeholder}
	m.in.SetValue("")
	m.in.Placeholder = placeholder
	m.scr, m.status = sInput, ""
	return m, m.in.Focus()
}

func (m *app) run(it item, arg string) (tea.Model, tea.Cmd) {
	m.streamID++
	m.cur, m.lastArg = it, arg
	m.back, m.scr, m.loading = sHome, sResult, true
	m.title = it.title
	if arg != "" {
		m.title += " · " + arg
	}
	m.body.Reset()
	m.vp.SetContent("")
	m.vp.GotoTop()
	m.omni.SetValue("")
	return m, tea.Batch(stream(m.streamID, textURL(it.path(arg))), m.kick())
}

func (m *app) update() (tea.Model, tea.Cmd) {
	m.back, m.scr, m.loading = sHome, sResult, true
	m.cur = item{}
	m.title = "Обновление hostpink"
	m.body.Reset()
	m.vp.SetContent("")
	return m, tea.Batch(func() tea.Msg {
		t, err := selfUpdate(false)
		return textMsg{title: "Обновление hostpink", body: t, err: err}
	}, m.kick())
}

func (m *app) openPlugins() (tea.Model, tea.Cmd) {
	m.scr, m.status, m.pFocus = sPlugins, "", 0
	if m.cat == nil && !m.catLoad {
		m.catLoad = true
		return m, tea.Batch(loadCatalogCmd(), m.kick())
	}
	return m, m.kick()
}

func (m *app) openPlugin(p Plugin) (tea.Model, tea.Cmd) {
	m.scr, m.status = sPlugins, ""
	m.filter.SetValue("")
	for i, x := range m.visiblePlugins() {
		if x.Key() == p.Key() {
			m.lSel = i
		}
	}
	m.aSel = 0
	if m.narrow() {
		m.plug, m.scr = p, sPlugin
		return m, nil
	}
	m.pFocus = 1
	return m, m.kick()
}

func (m *app) runPlugin(p Plugin, a Action) (tea.Model, tea.Cmd) {
	m.plug = p
	if !p.Supported() {
		m.status = sWarn.Render("Этот плагин для " + strings.Join(p.Platforms, ", ") + ". Поставь hostpink на сервер: curl -fsSL host.pink/tui | sh")
		return m, nil
	}
	m.loading, m.status = true, sDim.Render("Скачиваю файлы и сверяю SHA-256…")
	return m, tea.Batch(func() tea.Msg {
		dir, err := ensureFiles(p)
		return filesMsg{p, a, dir, err}
	}, m.kick())
}

func (m *app) viewCode(p Plugin) (tea.Model, tea.Cmd) {
	m.back = m.scr
	m.scr, m.loading = sResult, true
	m.cur = item{}
	m.title = p.Title + " · " + p.Files[0].Path
	m.body.Reset()
	m.vp.SetContent("")
	return m, tea.Batch(func() tea.Msg {
		t, err := readPluginFile(p, p.Files[0].Path)
		return textMsg{title: p.Title + " · " + p.Files[0].Path, body: t, err: err}
	}, m.kick())
}

func (m *app) removeUserPlugin(p Plugin) (tea.Model, tea.Cmd) {
	if err := removePlugin(p.ID); err != nil {
		m.status = sBad.Render("✗ " + err.Error())
		return m, nil
	}
	m.scr, m.status, m.catLoad, m.pFocus = sPlugins, sOK.Render("✓ Плагин удалён"), true, 0
	return m, tea.Batch(loadCatalogCmd(), m.kick())
}

func loadCatalogCmd() tea.Cmd {
	return func() tea.Msg { return catalogMsg(loadCatalog()) }
}

func (m *app) registries() []Registry {
	if m.cat == nil {
		return nil
	}
	return m.cat.Registries
}

func (m *app) featured() []Plugin {
	if m.cat == nil {
		return nil
	}
	var out []Plugin
	for _, p := range m.cat.Plugins {
		if p.Featured && p.Trust != "user" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		for _, p := range m.cat.Plugins {
			if p.Trust == "official" && len(out) < 4 {
				out = append(out, p)
			}
		}
	}
	return out
}

// visiblePlugins: каталог в порядке показа. Без фильтра сверху «Рекомендуем» (популярные,
// которые запустятся на этой системе), затем остальные популярные, затем всё по категориям.
// С фильтром — плоский список: сначала совпадения в названии, потом в описании и авторе.
func (m *app) visiblePlugins() []Plugin {
	if m.cat == nil {
		return nil
	}
	q := strings.ToLower(strings.TrimSpace(m.filter.Value()))
	var rec, pop, rest, hitTitle, hitOther []Plugin
	for _, p := range m.cat.Plugins {
		if q != "" {
			switch {
			case strings.Contains(strings.ToLower(p.Title+" "+p.ID), q):
				p.Group = "найдено"
				hitTitle = append(hitTitle, p)
			case strings.Contains(strings.ToLower(p.Description+" "+p.Author+" "+p.Category+" "+p.Repo), q):
				p.Group = "найдено"
				hitOther = append(hitOther, p)
			}
			continue
		}
		switch {
		case p.Featured && p.Supported():
			p.Group = "рекомендуем для " + osName()
			rec = append(rec, p)
		case p.Featured:
			p.Group = "популярные"
			pop = append(pop, p)
		default:
			p.Group = p.Category
			switch p.Trust {
			case "registry":
				p.Group = "реестр " + p.Registry
			case "user":
				p.Group = "добавлены тобой"
			}
			rest = append(rest, p)
		}
	}
	if q != "" {
		return append(hitTitle, hitOther...)
	}
	return append(append(rec, pop...), rest...)
}

// matchPlugin ищет плагин по названию для главного поля: «решала», «yabs», «warp».
func (m *app) matchPlugin(q string) (Plugin, bool) {
	q = strings.ToLower(strings.TrimSpace(q))
	if m.cat == nil || len([]rune(q)) < 3 || strings.ContainsAny(q, "./:?") {
		return Plugin{}, false
	}
	for _, p := range m.cat.Plugins {
		t := strings.ToLower(p.Title)
		if strings.HasPrefix(t, q) || strings.HasPrefix(p.ID, q) || strings.Contains(t, " "+q) {
			return p, true
		}
	}
	return Plugin{}, false
}

func osName() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	case "freebsd":
		return "FreeBSD"
	}
	return "Linux"
}

func (m *app) clampPlugins() {
	n := len(m.visiblePlugins())
	if m.lSel >= n {
		m.lSel = max(0, n-1)
	}
}

func (m *app) narrow() bool { return m.pageWidth() < 96 }

// ---------- отрисовка ----------

func (m *app) View() tea.View {
	var body string
	switch m.scr {
	case sSplash:
		body = m.viewSplash()
	case sHome:
		body = m.page(m.viewHome(), m.homeKeys())
	case sInput:
		body = m.page(m.viewInput(), keys("enter", "поехали", "esc", "назад"))
	case sResult:
		k := keys("↑↓", "листать", "PgUp PgDn", "страница", "esc", "назад")
		if m.back == sHome && m.cur.path != nil {
			k = keys("↑↓", "листать", "r", "ещё раз", "esc", "назад")
		}
		body = m.page(m.viewResult(), k)
	case sPlugins:
		body = m.page(m.viewPlugins(), m.pluginKeys())
	case sPlugin:
		body = m.page(box(m.plug.Title, m.pluginDetail(m.plug, true, m.pageWidth()-4), m.pageWidth(), m.h-3, true), keys("↑↓", "действие", "enter", "запустить", "v", "код", "esc", "назад"))
	case sRegistries:
		body = m.page(m.viewRegistries(), keys("↑↓", "выбрать", "a", "подключить", "d", "отключить свой", "esc", "назад"))
	case sExecDone:
		body = m.page(m.viewExecDone(), keys("любая клавиша", "назад"))
	}
	v := tea.NewView(body)
	v.AltScreen = true
	v.WindowTitle = "host.pink"
	return v
}

func (m *app) phase() int { return m.frame / 2 }

func (m *app) spinner() string { return sPink.Render(spinFrames[m.frame/4%len(spinFrames)]) }

// page: шапка + содержимое + статус + подвал с клавишами, по центру экрана.
func (m *app) page(content, footer string) string {
	w := m.pageWidth()
	parts := []string{m.topBar(), content}
	if m.status != "" {
		parts = append(parts, " "+m.status)
	}
	body := lipgloss.JoinVertical(lipgloss.Left, parts...)
	gap := m.h - lipgloss.Height(body) - 1
	if gap > 0 {
		body += strings.Repeat("\n", gap)
	}
	body += "\n " + truncateANSI(footer, w-2)
	return lipgloss.PlaceHorizontal(m.w, lipgloss.Center, lipgloss.NewStyle().Width(w).Render(body))
}

func (m *app) topBar() string {
	w := m.pageWidth()
	left := " " + gradient("host.pink", m.phase(), 3) + sDim.Render("  hostpink "+version)
	right := ""
	if m.me != nil {
		ip := m.me.IP
		if len(ip) > 22 {
			ip = ip[:21] + "…"
		}
		right = sOK.Render("●") + " " + sDim.Render(fmt.Sprintf("%s · AS%d · %s", ip, m.me.ASN, m.me.Country)) + " "
	}
	if m.loading || m.catLoad {
		right = m.spinner() + " " + right
	}
	gap := max(1, w-lipgloss.Width(left)-lipgloss.Width(right))
	return left + strings.Repeat(" ", gap) + right + "\n"
}

func (m *app) viewSplash() string {
	t := time.Since(m.start)
	reveal := int(t.Milliseconds() / 18)
	tag := "сеть, ТСПУ, хостеры и скрипты сообщества в одном терминале"
	shown := min(len([]rune(tag)), max(0, int((t.Milliseconds()-350)/14)))
	lines := []string{logo(m.phase(), min(reveal, logoWidth()+1)), "", sDim.Render(string([]rune(tag)[:shown]))}
	if t > 800*time.Millisecond {
		lines = append(lines, "", m.spinner()+" "+sDim.Render("подключаюсь к host.pink"))
	}
	return lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center, lipgloss.JoinVertical(lipgloss.Center, lines...))
}

// ---------- главный экран ----------

func (m *app) viewHome() string {
	w := m.pageWidth()
	var parts []string
	if m.h >= 34 {
		parts = append(parts, "", indent(logo(m.phase(), -1), 2), "")
	}

	// поле «куда угодно»
	hint := sDim.Render("enter")
	if p, ok := m.matchPlugin(m.omni.Value()); ok {
		hint = sPink.Render("→ плагин " + p.Title)
	} else if r, ok := routeQuery(m.omni.Value()); ok {
		hint = sPink.Render("→ " + r.label)
	}
	line := sPink.Render("host.pink/") + m.omni.View()
	gap := max(1, w-4-lipgloss.Width(line)-lipgloss.Width(hint))
	parts = append(parts, box("", line+strings.Repeat(" ", gap)+hint, w, 0, m.zone == zOmni))
	parts = append(parts, " "+sDim.Render("например: ")+sChip.Render("1.1.1.1 · example.com · AS13335 · что такое ТСПУ? · решала"), "")

	// инструменты и популярные плагины
	feat := m.featured()
	listH := m.h - lipgloss.Height(strings.Join(parts, "\n")) - 4
	compact := listH < len(tools)*2+2
	toolsW := 36
	if w < 96 {
		toolsW = w
	}
	toolsBox := box("Инструменты", m.toolsList(toolsW-4, compact), toolsW, 0, m.zone == zTools)
	featBody := m.featList(w-toolsW-1-4, compact, feat)
	if w < 96 {
		featBody = m.featList(w-4, true, feat)
	}
	featTitle := "Популярные плагины"
	if m.catLoad && m.cat == nil {
		featBody = m.spinner() + " " + sDim.Render("загружаю каталог…")
	}
	h := lipgloss.Height(toolsBox)
	if w >= 96 {
		featBox := box(featTitle, featBody, w-toolsW-1, h, m.zone == zFeat)
		parts = append(parts, lipgloss.JoinHorizontal(lipgloss.Top, toolsBox, " ", featBox))
	} else {
		parts = append(parts, toolsBox)
		if listH > h+4 {
			parts = append(parts, box(featTitle, featBody, w, 0, m.zone == zFeat))
		}
	}
	return strings.Join(parts, "\n")
}

func (m *app) toolsList(w int, compact bool) string {
	per := 2
	if compact {
		per = 1
	}
	top := int(m.tSp.pos*float64(per) + 0.5)
	var rows []string
	for i, t := range tools {
		for line := 0; line < per; line++ {
			r := i*per + line
			bar := "  "
			if m.zone == zTools && r >= top && r < top+per {
				bar = sPink.Render("▌ ")
			}
			if line == 0 {
				title := t.title
				if m.zone == zTools && i == m.tSel {
					title = sBold.Render(gradient(title, m.phase(), 2))
				}
				k := sKey.Render(t.key)
				rows = append(rows, bar+padRight(title, w-4)+k)
			} else {
				rows = append(rows, bar+sDim.Render(truncate(t.desc, w-3)))
			}
		}
	}
	return strings.Join(rows, "\n")
}

func (m *app) featList(w int, compact bool, feat []Plugin) string {
	if len(feat) == 0 {
		return sDim.Render("Каталог недоступен. p — открыть плагины")
	}
	per := 3
	if compact {
		per = 2
	}
	top := int(m.fSp.pos*float64(per) + 0.5)
	var rows []string
	for i, p := range feat {
		sel := m.zone == zFeat && i == m.fSel
		for line := 0; line < per; line++ {
			r := i*per + line
			bar := "  "
			if m.zone == zFeat && r >= top && r < top+per-1 {
				bar = sPink.Render("▌ ")
			}
			switch line {
			case 0:
				title := sBold.Render(p.Title)
				if sel {
					title = sBold.Render(gradient(p.Title, m.phase(), 2))
				}
				tags := pluginTags(p)
				rows = append(rows, bar+title+strings.Repeat(" ", max(1, w-2-lipgloss.Width(title)-lipgloss.Width(tags)))+tags)
			case 1:
				if per == 3 {
					rows = append(rows, bar+sDim.Render(truncate(p.Description, w-3)))
				} else {
					rows = append(rows, bar+sDim.Render(truncate(p.Author+" · "+p.Description, w-3)))
				}
			default:
				rows = append(rows, "")
			}
		}
	}
	return strings.Join(rows, "\n")
}

func pluginTags(p Plugin) string {
	var t []string
	if p.NeedsRoot {
		t = append(t, sWarn.Render("root"))
	}
	if !p.Supported() {
		t = append(t, sDim.Render(strings.Join(p.Platforms, "/")))
	}
	switch p.Trust {
	case "registry":
		t = append(t, sChip.Render(p.Registry))
	case "user":
		t = append(t, sWarn.Render("свой"))
	}
	return strings.Join(t, " ")
}

func (m *app) homeKeys() string {
	if m.zone == zOmni {
		return keys("enter", "открыть", "tab ↓", "к спискам", "esc", "очистить", "ctrl+c", "выход")
	}
	return keys("↑↓←→", "выбор", "enter", "открыть", "d c n t i s a", "инструменты", "p", "плагины", "/", "поиск", "u", "обновить", "q", "выход")
}

// ---------- ввод ----------

func (m *app) viewInput() string {
	w := m.pageWidth()
	var lines []string
	lines = append(lines, "", sBold.Render(m.cur.prompt), "")
	lines = append(lines, box("", m.in.View(), w-4, 0, true))
	switch m.inMode {
	case "plugin":
		lines = append(lines, "", sDim.Render("В корне репозитория должен лежать hostpink.toml. Плагин закрепится на текущем коммите,"), sDim.Render("хэши файлов запомнятся. Код из чужого репозитория никто не проверял — читай его клавишей v."))
	case "registry":
		lines = append(lines, "", sDim.Render("Реестр — репозиторий с hostpink-registry.json в корне: список плагинов, закреплённых на коммитах."))
	default:
		if m.cur.examples != "" {
			lines = append(lines, "", sDim.Render("например: ")+sChip.Render(m.cur.examples))
		}
	}
	return box(m.cur.title, strings.Join(lines, "\n"), w, 0, true)
}

// ---------- результат ----------

func (m *app) viewResult() string {
	w := m.pageWidth()
	title := m.title
	var body string
	if m.body.Len() == 0 && m.loading {
		body = "\n " + m.spinner() + " " + sDim.Render("спрашиваю host.pink…")
	} else {
		body = m.vp.View()
		if pct := m.vp.ScrollPercent(); m.vp.TotalLineCount() > m.vp.Height() {
			title += fmt.Sprintf("  %d%%", int(pct*100))
		}
	}
	if m.loading {
		title = spinFrames[m.frame/4%len(spinFrames)] + " " + title
	}
	return box(title, body, w, m.h-3, true)
}

// ---------- плагины ----------

func (m *app) viewPlugins() string {
	w := m.pageWidth()
	h := m.h - 3
	if m.cat == nil {
		return box("Плагины", "\n "+m.spinner()+" "+sDim.Render("загружаю каталог и реестры…"), w, h, true)
	}
	list := m.visiblePlugins()
	listW := 46
	if m.narrow() {
		listW = w
	}
	var head string
	switch {
	case m.filtering:
		head = sPink.Render("⌕ ") + m.filter.View()
	case m.filter.Value() != "":
		head = sPink.Render("⌕ ") + sBold.Render(m.filter.Value()) + sDim.Render(fmt.Sprintf("  %d найдено · esc сбросить", len(list)))
	default:
		head = sPink.Render("⌕ ") + sDim.Render("/ — поиск: название, автор, описание")
	}
	head = box("", head, listW-4, 0, m.filtering)
	left := box("Плагины", head+"\n"+m.pluginList(list, listW-4, h-7), listW, h, m.pFocus == 0 && !m.filtering)
	if m.narrow() {
		return left
	}
	var detail string
	if len(list) > 0 {
		detail = m.pluginDetail(list[m.lSel], m.pFocus == 1, w-listW-5)
	} else {
		detail = sDim.Render("Ничего не нашлось.")
	}
	title := ""
	if len(list) > 0 {
		title = list[m.lSel].Title
	}
	right := box(title, detail, w-listW-1, h, m.pFocus == 1)
	return lipgloss.JoinHorizontal(lipgloss.Top, left, " ", right)
}

func (m *app) pluginList(list []Plugin, w, h int) string {
	if len(list) == 0 {
		return sDim.Render("пусто")
	}
	// строки: заголовки категорий + плагины; запоминаем, на какой строке каждый плагин
	type row struct {
		text string
		idx  int
	}
	var rows []row
	pos := make([]int, len(list))
	last := ""
	for i, p := range list {
		group := p.Group
		if group != last {
			if last != "" {
				rows = append(rows, row{"", -1})
			}
			rows = append(rows, row{sChip.Render(strings.ToUpper(group)), -1})
			last = group
		}
		pos[i] = len(rows)
		rows = append(rows, row{"", i})
	}
	// пружина едет по строкам, перепрыгивая заголовки плавно
	f := m.lSp.pos
	i0 := max(0, min(len(list)-1, int(math.Floor(f))))
	i1 := min(len(list)-1, i0+1)
	barRow := int(float64(pos[i0]) + (float64(pos[i1])-float64(pos[i0]))*(f-float64(i0)) + 0.5)
	if f < 0 {
		barRow = pos[0]
	}
	first := 0
	if pos[m.lSel] >= h {
		first = pos[m.lSel] - h + 1
	}
	var out []string
	for r := first; r < min(len(rows), first+h); r++ {
		x := rows[r]
		if x.idx < 0 {
			out = append(out, "  "+x.text)
			continue
		}
		p := list[x.idx]
		bar := "  "
		if r == barRow {
			bar = sPink.Render("▌ ")
		}
		title := p.Title
		if x.idx == m.lSel {
			if m.pFocus == 0 {
				title = sBold.Render(gradient(title, m.phase(), 2))
			} else {
				title = sBold.Render(title)
			}
		}
		tags := pluginTags(p)
		out = append(out, bar+truncateANSI(title, w-4-lipgloss.Width(tags))+strings.Repeat(" ", max(1, w-2-lipgloss.Width(title)-lipgloss.Width(tags)))+tags)
	}
	return strings.Join(out, "\n")
}

func (m *app) pluginDetail(p Plugin, focus bool, w int) string {
	var b strings.Builder
	wrap := lipgloss.NewStyle().Width(w)
	line := func(text string, c color.Color) { b.WriteString(wrap.Render(badge(text, c)) + "\n") }
	b.WriteString(sDim.Render(p.Category+" · автор "+p.Author) + "\n\n")
	b.WriteString(wrap.Render(p.Description) + "\n\n")

	switch p.Trust {
	case "registry":
		line("реестр «"+p.Registry+"»", cViolet)
	case "user":
		line("добавлен тобой из git, код никто не проверял", cWarn)
	default:
		line("официальный каталог host.pink", cOK)
	}
	line("github.com/"+p.Repo+" @ "+p.Ref[:7], cDim)
	if p.NeedsRoot {
		line("нужен root: запустится через sudo", cWarn)
	}
	if p.FetchesLatest {
		line("сам докачивает код из своей ветки — закреплён только загрузчик", cWarn)
	}
	if p.Supported() {
		line("работает на "+strings.Join(p.Platforms, ", "), cOK)
	} else {
		line("работает на "+strings.Join(p.Platforms, ", ")+", а у тебя "+osName()+": поставь hostpink на сервер", cBad)
	}
	var files []string
	for _, f := range p.Files {
		files = append(files, f.Path+" "+sDim.Render(f.SHA256[:10]))
	}
	line("SHA-256: "+strings.Join(files, ", "), cDim)
	b.WriteString("\n")

	b.WriteString(section("Действия") + "\n")
	for i, a := range p.Actions {
		mark, title := "  ", a.Title
		if i == m.aSel {
			if focus {
				mark, title = sPink.Render("▶ "), sBold.Render(gradient(a.Title, m.phase(), 2))
			} else {
				mark = sDim.Render("› ")
			}
		}
		b.WriteString(mark + title + "\n    " + sDim.Render("$ "+a.Run) + "\n")
	}
	return b.String()
}

func (m *app) pluginKeys() string {
	if m.filtering {
		return keys("enter", "готово", "esc", "сбросить")
	}
	if m.pFocus == 1 {
		return keys("↑↓", "действие", "enter", "запустить", "v", "код", "← esc", "к списку")
	}
	return keys("↑↓", "выбрать", "enter →", "действия", "/", "фильтр", "v", "код", "a", "из git", "g", "реестры", "esc", "домой")
}

func (m *app) viewRegistries() string {
	regs := m.registries()
	var b strings.Builder
	b.WriteString(badge("host.pink", cOK) + sDim.Render("  корневой реестр Rxflex/hostpink-registry: его плагины и реестры, на которые он ссылается") + "\n\n")
	for i, r := range regs {
		mark := "  "
		if i == m.rSel {
			mark = sPink.Render("▶ ")
		}
		kind := sChip.Render("из корневого реестра")
		if r.Via != "" && r.Via != "host.pink" && r.Via != "ты" {
			kind = sChip.Render("через " + r.Via)
		}
		if !r.Official {
			kind = sWarn.Render("твой")
		}
		where := r.Repo
		if where == "" {
			where = r.URL
		}
		b.WriteString(mark + sBold.Render(r.Name) + "  " + kind + "  " + sDim.Render(where) + "\n")
		if r.Description != "" {
			b.WriteString("    " + sDim.Render(r.Description) + "\n")
		}
	}
	if len(regs) == 0 {
		b.WriteString(sDim.Render("Сторонних реестров нет. a — подключить: любой репозиторий с hostpink-registry.json.") + "\n")
	}
	return box("Реестры плагинов", b.String(), m.pageWidth(), m.h-3, true)
}

func (m *app) viewExecDone() string {
	var msg string
	switch {
	case m.execErr == nil:
		msg = sOK.Render("✓ " + m.plug.Title + " отработал")
	case m.execCode != 0:
		msg = sBad.Render(fmt.Sprintf("✗ %s завершился с кодом %d", m.plug.Title, m.execCode))
	default:
		msg = sBad.Render("✗ " + m.execErr.Error())
	}
	return box(m.plug.Title, "\n"+msg+"\n", m.pageWidth(), 0, true)
}

func indent(s string, n int) string {
	pad := strings.Repeat(" ", n)
	return pad + strings.ReplaceAll(s, "\n", "\n"+pad)
}

func padRight(s string, n int) string {
	if w := lipgloss.Width(s); w < n {
		return s + strings.Repeat(" ", n-w)
	}
	return s
}

func truncate(s string, n int) string {
	r := []rune(s)
	if n < 4 || len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}
