package main

import (
	"errors"
	"fmt"
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
	sMenu
	sInput
	sResult
	sPlugins
	sPlugin
	sRegistries
	sExecDone
)

type item struct {
	id, title, desc     string
	prompt, placeholder string
	path                func(string) string
}

var menu = []item{
	{id: "ip", title: "Мой IP", desc: "адрес, провайдер и сеть, с которых ты сейчас выходишь", path: func(string) string { return "/ip" }},
	{id: "dossier", title: "Досье", desc: "IP, домен, AS или префикс: владелец, порты, BGP, репутация", prompt: "Что проверить", placeholder: "1.1.1.1, example.com, AS13335, 1.1.1.0/24", path: func(s string) string { return "/" + pathArg(s) }},
	{id: "check", title: "Доступность из РФ и мира", desc: "HTTP из российских домашних сетей, дата-центров и других стран", prompt: "Сайт или хост", placeholder: "example.com", path: func(s string) string { return "/check/" + pathArg(s) }},
	{id: "dns", title: "DNS", desc: "A, AAAA, MX, TXT, NS, CAA и остальные записи", prompt: "Домен", placeholder: "example.com", path: func(s string) string { return "/dns/" + pathArg(s) }},
	{id: "ping", title: "TCP-пинг", desc: "время установки соединения с эджа Cloudflare", prompt: "Хост и порт", placeholder: "example.com:443", path: func(s string) string { return "/ping/" + pathArg(s) }},
	{id: "search", title: "Поиск по базе", desc: "BedolagaBD и гайды host.pink: панели, Xray, ТСПУ, хостеры", prompt: "Что ищем", placeholder: "reality selfsteal", path: func(s string) string { return "/search?q=" + url.QueryEscape(s) }},
	{id: "ask", title: "Спросить ИИ", desc: "ответ по базе знаний со ссылками на источники", prompt: "Вопрос", placeholder: "почему нода пингуется, но не работает?", path: func(s string) string { return "/ask?q=" + url.QueryEscape(s) }},
	{id: "plugins", title: "Плагины", desc: "скрипты сообщества: Решала, установщики, бэкапы, проверки"},
	{id: "update", title: "Обновить hostpink", desc: "скачать свежую версию и проверить контрольную сумму"},
	{id: "quit", title: "Выход", desc: "до встречи"},
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

type app struct {
	w, h   int
	scr    screen
	noAnim bool
	frame  int
	start  time.Time

	spring harmonica.Spring
	sel    int
	pos    float64
	vel    float64

	me    *myIP
	meErr error

	// ввод
	inMode string // tool | plugin | registry
	cur    item
	in     textinput.Model

	// результат
	vp       viewport.Model
	title    string
	body     strings.Builder
	loading  bool
	streamID int
	resErr   error
	back     screen

	// плагины
	cat      *Catalog
	catLoad  bool
	pSel     int
	ppos     float64
	pvel     float64
	plug     Plugin
	aSel     int
	rSel     int
	status   string
	execCode int
	execErr  error
}

func newApp(noAnim bool) *app {
	in := textinput.New()
	in.Prompt = "› "
	in.CharLimit = 300
	vp := viewport.New(viewport.WithWidth(80), viewport.WithHeight(20))
	vp.SoftWrap = true
	return &app{
		scr:    sSplash,
		noAnim: noAnim,
		start:  time.Now(),
		spring: harmonica.NewSpring(harmonica.FPS(60), 7.5, 0.72),
		pos:    -1.5,
		ppos:   -1,
		in:     in,
		vp:     vp,
		w:      80,
		h:      24,
	}
}

func tick() tea.Cmd {
	return tea.Tick(time.Second/60, func(t time.Time) tea.Msg { return frameMsg(t) })
}

func (m *app) Init() tea.Cmd {
	cleanupOld()
	if m.noAnim {
		m.scr, m.pos, m.ppos = sMenu, 0, 0
		return fetchIP()
	}
	return tea.Batch(fetchIP(), tick())
}

// animating: нужен ли следующий кадр. Когда всё стоит, TUI не жжёт процессор.
func (m *app) animating() bool {
	if m.noAnim {
		return false
	}
	moving := func(pos, vel float64, target int) bool {
		return abs(pos-float64(target)) > 0.01 || abs(vel) > 0.01
	}
	switch m.scr {
	case sSplash:
		return true
	case sMenu:
		return moving(m.pos, m.vel, m.sel) || time.Since(m.start) < 4*time.Second
	case sPlugins:
		return moving(m.ppos, m.pvel, m.pSel) || m.catLoad
	}
	return m.loading
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

func (m *app) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		m.resize()
		return m, nil

	case frameMsg:
		m.frame++
		if m.scr == sSplash && time.Since(m.start) > 1600*time.Millisecond {
			m.toMenu()
		}
		m.pos, m.vel = m.spring.Update(m.pos, m.vel, float64(m.sel))
		m.ppos, m.pvel = m.spring.Update(m.ppos, m.pvel, float64(m.pSel))
		if m.animating() {
			return m, tick()
		}
		return m, nil

	case ipMsg:
		m.me, m.meErr = msg.ip, msg.err
		return m, nil

	case chunkMsg:
		if msg.id == m.streamID {
			m.body.WriteString(msg.data)
			m.vp.SetContent(m.body.String())
		}
		return m, nil

	case streamDoneMsg:
		if msg.id == m.streamID {
			m.loading, m.resErr = false, msg.err
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
		if m.pSel >= len(c.Plugins) {
			m.pSel = 0
		}
		return m, nil

	case addedMsg:
		m.loading = false
		if msg.err != nil {
			m.status = sBad.Render("✗ " + msg.err.Error())
			m.scr = sPlugins
			return m, nil
		}
		if msg.p != nil {
			m.status = sOK.Render("✓ Добавлен " + msg.p.Title + ", закреплён на " + msg.p.Ref[:7])
		} else {
			m.status = sOK.Render("✓ Реестр " + msg.reg.Name + " добавлен")
		}
		m.scr = sPlugins
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

	// всё остальное (мигание курсора и т. п.) — текущему компоненту
	var cmd tea.Cmd
	switch m.scr {
	case sInput:
		m.in, cmd = m.in.Update(msg)
	case sResult:
		m.vp, cmd = m.vp.Update(msg)
	}
	return m, cmd
}

func (m *app) kick() tea.Cmd {
	if m.noAnim {
		return nil
	}
	return tick()
}

func (m *app) toMenu() {
	m.scr = sMenu
	m.status = ""
}

func (m *app) resize() {
	m.vp.SetWidth(max(20, m.contentWidth()))
	m.vp.SetHeight(max(5, m.h-8))
	m.in.SetWidth(max(20, m.contentWidth()-4))
}

func (m *app) contentWidth() int {
	return min(m.w-4, 110)
}

func (m *app) key(k tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	s := k.String()
	if s == "ctrl+c" {
		return m, tea.Quit
	}
	switch m.scr {
	case sSplash:
		m.toMenu()
		return m, m.kick()

	case sMenu:
		switch s {
		case "q", "esc":
			return m, tea.Quit
		case "up", "k":
			m.sel = (m.sel - 1 + len(menu)) % len(menu)
			return m, m.kick()
		case "down", "j", "tab":
			m.sel = (m.sel + 1) % len(menu)
			return m, m.kick()
		case "enter", "space":
			return m.open(menu[m.sel])
		}
		if len(s) == 1 && s[0] >= '1' && s[0] <= '9' && int(s[0]-'1') < len(menu) {
			m.sel = int(s[0] - '1')
			return m.open(menu[m.sel])
		}

	case sInput:
		switch s {
		case "esc":
			if m.inMode == "tool" {
				m.toMenu()
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
				m.loading = true
				m.status = "Читаю hostpink.toml из " + v + "…"
				return m, tea.Batch(func() tea.Msg { p, err := addPlugin(v); return addedMsg{p: &p, err: err} }, m.kick())
			case "registry":
				m.loading = true
				m.status = "Читаю реестр " + v + "…"
				return m, tea.Batch(func() tea.Msg { r, err := addRegistry(v); return addedMsg{reg: &r, err: err} }, m.kick())
			}
			return m.run(m.cur, v)
		}
		var cmd tea.Cmd
		m.in, cmd = m.in.Update(k)
		return m, cmd

	case sResult:
		switch s {
		case "esc", "q", "backspace":
			m.streamID++
			m.loading = false
			if m.back == sPlugin {
				m.scr = sPlugin
			} else {
				m.toMenu()
			}
			return m, m.kick()
		case "r":
			if m.back != sPlugin && m.cur.path != nil {
				return m.run(m.cur, m.in.Value())
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

	case sPlugins:
		n := 0
		if m.cat != nil {
			n = len(m.cat.Plugins)
		}
		switch s {
		case "esc", "q":
			m.toMenu()
			return m, m.kick()
		case "up", "k":
			if n > 0 {
				m.pSel = (m.pSel - 1 + n) % n
			}
			return m, m.kick()
		case "down", "j", "tab":
			if n > 0 {
				m.pSel = (m.pSel + 1) % n
			}
			return m, m.kick()
		case "enter", "space":
			if n > 0 {
				m.plug, m.aSel, m.status = m.cat.Plugins[m.pSel], 0, ""
				m.scr = sPlugin
			}
			return m, nil
		case "a":
			return m.ask("plugin", "Добавить плагин из git", "github.com/owner/repo")
		case "g":
			m.scr, m.rSel = sRegistries, 0
			return m, nil
		case "r":
			m.catLoad, m.status = true, ""
			return m, tea.Batch(loadCatalogCmd(), m.kick())
		}

	case sPlugin:
		p := m.plug
		switch s {
		case "esc", "q", "backspace":
			m.scr, m.status = sPlugins, ""
			return m, m.kick()
		case "up", "k":
			m.aSel = (m.aSel - 1 + len(p.Actions)) % len(p.Actions)
		case "down", "j", "tab":
			m.aSel = (m.aSel + 1) % len(p.Actions)
		case "v":
			m.back, m.scr, m.loading = sPlugin, sResult, true
			m.title = p.Title + " · " + p.Files[0].Path
			m.body.Reset()
			m.vp.SetContent("")
			return m, tea.Batch(func() tea.Msg {
				t, err := readPluginFile(p, p.Files[0].Path)
				return textMsg{title: p.Title + " · " + p.Files[0].Path, body: t, err: err}
			}, m.kick())
		case "d":
			if p.Trust == "user" {
				if err := removePlugin(p.ID); err != nil {
					m.status = sBad.Render("✗ " + err.Error())
					return m, nil
				}
				m.scr, m.status, m.catLoad = sPlugins, sOK.Render("✓ Плагин удалён"), true
				return m, tea.Batch(loadCatalogCmd(), m.kick())
			}
		case "enter":
			if !p.Supported() {
				m.status = sWarn.Render("Этот плагин для " + strings.Join(p.Platforms, ", ") + ". Запусти hostpink прямо на сервере: curl -fsSL host.pink/tui | sh")
				return m, nil
			}
			a := p.Actions[m.aSel]
			m.loading = true
			m.status = "Скачиваю и проверяю файлы…"
			return m, tea.Batch(func() tea.Msg {
				dir, err := ensureFiles(p)
				return filesMsg{p, a, dir, err}
			}, m.kick())
		}
		return m, nil

	case sRegistries:
		regs := m.registries()
		switch s {
		case "esc", "q", "backspace":
			m.scr = sPlugins
			return m, m.kick()
		case "up", "k":
			if len(regs) > 0 {
				m.rSel = (m.rSel - 1 + len(regs)) % len(regs)
			}
		case "down", "j", "tab":
			if len(regs) > 0 {
				m.rSel = (m.rSel + 1) % len(regs)
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

	case sExecDone:
		m.scr = sPlugin
		return m, nil
	}
	return m, nil
}

func (m *app) ask(mode, prompt, placeholder string) (tea.Model, tea.Cmd) {
	m.inMode = mode
	m.cur = item{title: prompt, prompt: prompt, placeholder: placeholder}
	m.in.SetValue("")
	m.in.Placeholder = placeholder
	m.scr = sInput
	m.status = ""
	return m, m.in.Focus()
}

func (m *app) open(it item) (tea.Model, tea.Cmd) {
	m.cur = it
	switch it.id {
	case "quit":
		return m, tea.Quit
	case "plugins":
		m.scr, m.status = sPlugins, ""
		if m.cat == nil {
			m.catLoad = true
			return m, tea.Batch(loadCatalogCmd(), m.kick())
		}
		return m, m.kick()
	case "update":
		m.back, m.scr, m.loading = sMenu, sResult, true
		m.title = "Обновление hostpink"
		m.body.Reset()
		m.vp.SetContent("")
		return m, tea.Batch(func() tea.Msg {
			t, err := selfUpdate(false)
			return textMsg{title: "Обновление hostpink", body: t, err: err}
		}, m.kick())
	}
	if it.prompt == "" {
		return m.run(it, "")
	}
	m.inMode = "tool"
	m.in.SetValue("")
	m.in.Placeholder = it.placeholder
	m.scr = sInput
	return m, m.in.Focus()
}

func (m *app) run(it item, arg string) (tea.Model, tea.Cmd) {
	m.streamID++
	m.back, m.scr, m.loading, m.resErr = sMenu, sResult, true, nil
	m.title = it.title
	if arg != "" {
		m.title += " · " + arg
	}
	m.body.Reset()
	m.vp.SetContent("")
	m.vp.GotoTop()
	return m, tea.Batch(stream(m.streamID, textURL(it.path(arg))), m.kick())
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

// ---------- отрисовка ----------

func (m *app) View() tea.View {
	var body string
	switch m.scr {
	case sSplash:
		body = m.viewSplash()
	case sMenu:
		body = m.frameView("", m.viewMenu(), "↑↓ выбрать · enter открыть · 1–9 быстро · q выход")
	case sInput:
		body = m.frameView(m.cur.title, m.viewInput(), "enter поехали · esc назад")
	case sResult:
		help := "↑↓ PgUp PgDn листать · esc назад"
		if m.back != sPlugin && m.cur.path != nil {
			help = "↑↓ PgUp PgDn листать · r ещё раз · esc назад"
		}
		body = m.frameView(m.title, m.viewResult(), help)
	case sPlugins:
		body = m.frameView("Плагины", m.viewPlugins(), "↑↓ выбрать · enter открыть · a добавить из git · g реестры · r обновить · esc назад")
	case sPlugin:
		help := "↑↓ действие · enter запустить · v код · esc назад"
		if m.plug.Trust == "user" {
			help += " · d удалить"
		}
		body = m.frameView(m.plug.Title, m.viewPlugin(), help)
	case sRegistries:
		body = m.frameView("Реестры плагинов", m.viewRegistries(), "↑↓ выбрать · a подключить · d отключить свой · esc назад")
	case sExecDone:
		body = m.frameView(m.plug.Title, m.viewExecDone(), "любая клавиша — назад")
	}
	v := tea.NewView(body)
	v.AltScreen = true
	v.WindowTitle = "host.pink"
	return v
}

func (m *app) phase() int { return m.frame / 2 }

func (m *app) viewSplash() string {
	t := time.Since(m.start)
	reveal := int(t.Milliseconds() / 18)
	lw := logoWidth()
	tag := "сеть, ТСПУ, хостеры и скрипты сообщества — в одном терминале"
	shown := min(len([]rune(tag)), max(0, int((t.Milliseconds()-400)/14)))
	lines := []string{
		logo(m.phase(), min(reveal, lw+1)),
		"",
		sDim.Render(string([]rune(tag)[:shown])),
	}
	if t > 900*time.Millisecond {
		lines = append(lines, "", sDim.Render(spinFrames[m.frame/4%len(spinFrames)]+" подключаюсь к host.pink"))
	}
	return lipgloss.Place(m.w, m.h, lipgloss.Center, lipgloss.Center, lipgloss.JoinVertical(lipgloss.Center, lines...))
}

func (m *app) header(title string) string {
	w := m.contentWidth()
	left := gradient("host.pink", m.phase(), 3)
	if title != "" {
		left += sDim.Render("  /  ") + sBold.Render(title)
	}
	right := ""
	if m.me != nil {
		right = sDim.Render(fmt.Sprintf("%s · AS%d · %s", m.me.IP, m.me.ASN, m.me.Country))
	}
	if m.loading || m.catLoad {
		right = sPink.Render(spinFrames[m.frame/4%len(spinFrames)]) + " " + right
	}
	gap := max(1, w-lipgloss.Width(left)-lipgloss.Width(right))
	return left + strings.Repeat(" ", gap) + right
}

func (m *app) frameView(title, content, help string) string {
	w := m.contentWidth()
	rule := sDim.Render(strings.Repeat("─", max(0, w)))
	parts := []string{m.header(title), rule, content}
	if m.status != "" {
		parts = append(parts, "", m.status)
	}
	page := lipgloss.JoinVertical(lipgloss.Left, parts...)
	footer := sDim.Render(help)
	gapLines := m.h - lipgloss.Height(page) - 2
	if gapLines > 0 {
		page += strings.Repeat("\n", gapLines)
	}
	page += "\n" + footer
	return lipgloss.NewStyle().Padding(0, 2).Render(page)
}

func (m *app) viewMenu() string {
	// сколько строк на пункт: 3 (заголовок, описание, воздух), 2 или 1 — чтобы влезть даже в 80×24
	avail := m.h - 6
	per := 3
	if len(menu)*3 > avail {
		per = 2
	}
	if len(menu)*2 > avail {
		per = 1
	}
	var rows []string
	if avail-len(menu)*per >= 5 && m.w >= logoWidth()+6 {
		rows = append(rows, "", logo(m.phase(), -1), "")
	} else {
		rows = append(rows, "")
	}
	// индикатор едет на пружине: pos — дробный номер пункта
	barTop := int(m.pos*float64(per) + 0.5)
	barH := min(2, per)
	w := m.contentWidth()
	for i, it := range menu {
		for line := 0; line < per; line++ {
			r := i*per + line
			bar := "  "
			if r >= barTop && r < barTop+barH {
				bar = sPink.Render("▌ ")
			}
			switch line {
			case 0:
				num := sDim.Render(fmt.Sprintf("%d ", i+1))
				if i >= 9 {
					num = "  "
				}
				title := it.title
				if i == m.sel {
					title = sBold.Render(gradient(title, m.phase(), 2))
				}
				row := bar + num + title
				if per == 1 {
					row += "  " + sDim.Render(truncate(it.desc, w-lipgloss.Width(row)-4))
				}
				rows = append(rows, row)
			case 1:
				rows = append(rows, bar+"  "+sDim.Render(truncate(it.desc, w-6)))
			default:
				rows = append(rows, "")
			}
		}
	}
	return strings.Join(rows, "\n")
}

func (m *app) viewInput() string {
	lines := []string{"", sBold.Render(m.cur.prompt)}
	switch m.inMode {
	case "plugin":
		lines = append(lines, sDim.Render("В корне репозитория должен лежать hostpink.toml. Плагин закрепится на текущем коммите,"), sDim.Render("а хэши файлов запомнятся: любое изменение в репозитории будет видно. Код никто не проверял."))
	case "registry":
		lines = append(lines, sDim.Render("Реестр — репозиторий с файлом hostpink-registry.json, в нём список плагинов, закреплённых на коммитах."))
	}
	lines = append(lines, "", sBorder.Width(m.contentWidth()-2).Render(m.in.View()))
	return strings.Join(lines, "\n")
}

func (m *app) viewResult() string {
	if m.body.Len() == 0 && m.loading {
		return "\n" + sPink.Render(spinFrames[m.frame/4%len(spinFrames)]) + " " + sDim.Render("спрашиваю host.pink…")
	}
	return m.vp.View()
}

func (m *app) viewPlugins() string {
	if m.cat == nil {
		return "\n" + sPink.Render(spinFrames[m.frame/4%len(spinFrames)]) + " " + sDim.Render("загружаю каталог и реестры…")
	}
	c := m.cat
	if len(c.Plugins) == 0 {
		return "\nПлагинов пока нет. Нажми a, чтобы добавить из git."
	}
	// окно прокрутки вокруг выбранного
	per := 2
	visible := max(3, (m.h-10)/per)
	first := 0
	if m.pSel >= visible {
		first = m.pSel - visible + 1
	}
	barTop := int((m.ppos-float64(first))*float64(per) + 0.5)
	var rows []string
	lastCat := ""
	catW := 18
	if m.contentWidth() < 70 {
		catW = 0
	}
	for i := first; i < min(len(c.Plugins), first+visible); i++ {
		p := c.Plugins[i]
		r := (i - first) * per
		bar := "  "
		if r >= barTop && r < barTop+per {
			bar = sPink.Render("▌ ")
		}
		cat := p.Category
		if p.Trust != "official" {
			cat = p.Registry
		}
		head := strings.Repeat(" ", catW)
		if cat != lastCat {
			head = sChip.Render(padRight(truncate(cat, catW-2), catW))
			lastCat = cat
		}
		title := p.Title
		if i == m.pSel {
			title = sBold.Render(gradient(title, m.phase(), 2))
		}
		tags := []string{}
		if !p.Supported() {
			tags = append(tags, sDim.Render(strings.Join(p.Platforms, "/")))
		}
		if p.NeedsRoot {
			tags = append(tags, sWarn.Render("root"))
		}
		switch p.Trust {
		case "registry":
			tags = append(tags, sChip.Render("реестр "+p.Registry))
		case "user":
			tags = append(tags, sWarn.Render("свой, не проверен"))
		}
		rows = append(rows, bar+head+title+"  "+sDim.Render("· "+p.Author)+"  "+strings.Join(tags, " "))
		rows = append(rows, bar+strings.Repeat(" ", catW)+sDim.Render(truncate(p.Description, m.contentWidth()-catW-4)))
	}
	out := "\n" + strings.Join(rows, "\n")
	if len(c.Notes) > 0 {
		out += "\n\n" + sDim.Render(strings.Join(c.Notes, " · "))
	}
	return out
}

func (m *app) viewPlugin() string {
	p := m.plug
	w := m.contentWidth()
	var b strings.Builder
	b.WriteString("\n" + sDim.Render(p.Category+" · "+p.Author) + "\n\n")
	b.WriteString(lipgloss.NewStyle().Width(w).Render(p.Description) + "\n\n")

	src := badge("из каталога host.pink", cOK)
	switch p.Trust {
	case "registry":
		src = badge("из реестра «"+p.Registry+"»", cViolet)
	case "user":
		src = badge("добавлен тобой из git, код никто не проверял", cWarn)
	}
	b.WriteString(src + "\n")
	b.WriteString(badge("github.com/"+p.Repo+" @ "+p.Ref[:7], cDim) + "\n")
	if p.NeedsRoot {
		b.WriteString(badge("нужен root: запустится через sudo", cWarn) + "\n")
	}
	if p.FetchesLatest {
		b.WriteString(badge("сам докачивает код из своей ветки: закреплён только загрузчик", cWarn) + "\n")
	}
	if !p.Supported() {
		b.WriteString(badge("работает на "+strings.Join(p.Platforms, ", ")+", а у тебя "+runtime.GOOS, cBad) + "\n")
	}
	files := []string{}
	for _, f := range p.Files {
		files = append(files, f.Path+" "+sDim.Render(f.SHA256[:10]))
	}
	b.WriteString(badge("файлы: "+strings.Join(files, ", "), cDim) + "\n\n")

	b.WriteString(sBold.Render("Действия") + "\n")
	for i, a := range p.Actions {
		mark := "  "
		title := a.Title
		if i == m.aSel {
			mark = sPink.Render("▶ ")
			title = sBold.Render(title)
		}
		b.WriteString(mark + title + "  " + sDim.Render("$ "+a.Run) + "\n")
	}
	return b.String()
}

func (m *app) viewRegistries() string {
	regs := m.registries()
	var b strings.Builder
	b.WriteString("\n" + badge("host.pink", cOK) + sDim.Render("  встроенный каталог, всегда включён") + "\n\n")
	for i, r := range regs {
		mark := "  "
		if i == m.rSel {
			mark = sPink.Render("▶ ")
		}
		kind := sChip.Render("официальный")
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
		b.WriteString(sDim.Render("Сторонних реестров пока нет.") + "\n")
	}
	return b.String()
}

func (m *app) viewExecDone() string {
	if m.execErr == nil {
		return "\n" + sOK.Render("✓ Плагин отработал") + "\n"
	}
	if m.execCode != 0 {
		return "\n" + sBad.Render(fmt.Sprintf("✗ Плагин завершился с кодом %d", m.execCode)) + "\n"
	}
	return "\n" + sBad.Render("✗ "+m.execErr.Error()) + "\n"
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
