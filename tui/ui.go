package main

import (
	"regexp"
	"strings"

	"charm.land/lipgloss/v2"
)

// box рисует панель со скруглённой рамкой и заголовком, врезанным в верхнюю линию.
// Активная панель — розовая, остальные — приглушённые. h = 0: высота по содержимому.
func box(title, body string, w, h int, focused bool) string {
	if w < 8 {
		w = 8
	}
	bc := cRule
	tc := sDim
	if focused {
		bc = cPink
		tc = sTitle
	}
	b := lipgloss.NewStyle().Foreground(bc)
	inner := w - 4
	lines := strings.Split(body, "\n")
	if h > 0 {
		for len(lines) < h-2 {
			lines = append(lines, "")
		}
		if len(lines) > h-2 {
			lines = lines[:h-2]
		}
	}
	var out strings.Builder
	top := "╭"
	if title != "" {
		t := " " + tc.Render(title) + " "
		top += "─" + t
		top += strings.Repeat("─", max(0, w-3-lipgloss.Width(t)))
	} else {
		top += strings.Repeat("─", w-2)
	}
	out.WriteString(b.Render(top) + b.Render("╮") + "\n")
	for _, l := range lines {
		if lipgloss.Width(l) > inner {
			l = truncateANSI(l, inner)
		}
		out.WriteString(b.Render("│") + " " + l + strings.Repeat(" ", max(0, inner-lipgloss.Width(l))) + " " + b.Render("│") + "\n")
	}
	out.WriteString(b.Render("╰" + strings.Repeat("─", w-2) + "╯"))
	return out.String()
}

// truncateANSI обрезает строку со стилями до ширины n.
func truncateANSI(s string, n int) string {
	return lipgloss.NewStyle().MaxWidth(n).Render(s)
}

// keys рисует подсказку «клавиша действие» для подвала.
func keys(pairs ...string) string {
	var parts []string
	for i := 0; i+1 < len(pairs); i += 2 {
		parts = append(parts, sKey.Render(pairs[i])+" "+sDim.Render(pairs[i+1]))
	}
	return strings.Join(parts, sDim.Render("   "))
}

func section(title string) string {
	return sPink.Render("● ") + sBold.Render(title)
}

// ---------- куда вести ввод из главного поля ----------

var (
	reIPv4   = regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$`)
	reIPv6   = regexp.MustCompile(`^[0-9a-fA-F:]+:[0-9a-fA-F:.]*(/\d{1,3})?$`)
	reAS     = regexp.MustCompile(`(?i)^as\d{1,10}$`)
	reDomain = regexp.MustCompile(`(?i)^([\p{L}\d-]+\.)+[\p{L}\d-]{2,}\.?$`)
	rePort   = regexp.MustCompile(`(?i)^([\p{L}\d.-]+|\[[0-9a-f:]+\]):\d{1,5}$`)
)

type route struct {
	label string // что покажется в подсказке
	it    item
	arg   string
}

// routeQuery повторяет логику host.pink/go: IP, домен, AS и префикс — в досье,
// хост:порт — в TCP-пинг, вопрос — ИИ, всё остальное — поиск по базе.
func routeQuery(q string) (route, bool) {
	q = strings.TrimSpace(q)
	if q == "" {
		return route{}, false
	}
	q = strings.TrimPrefix(strings.TrimPrefix(q, "https://"), "http://")
	if strings.HasPrefix(q, "host.pink/") {
		q = strings.TrimPrefix(q, "host.pink/")
	}
	switch {
	case reIPv4.MatchString(q), reIPv6.MatchString(q) && strings.Count(q, ":") >= 2, reAS.MatchString(q):
		return route{"досье", toolByID("dossier"), q}, true
	case rePort.MatchString(q):
		return route{"TCP-пинг", toolByID("ping"), q}, true
	case reDomain.MatchString(strings.TrimSuffix(q, "/")) && !strings.Contains(q, " "):
		return route{"досье домена", toolByID("dossier"), strings.TrimSuffix(q, "/")}, true
	case strings.HasSuffix(q, "?") || (strings.Contains(q, " ") && len([]rune(q)) > 18):
		return route{"вопрос ИИ", toolByID("ask"), q}, true
	}
	return route{"поиск по базе", toolByID("search"), q}, true
}

func toolByID(id string) item {
	for _, t := range tools {
		if t.id == id {
			return t
		}
	}
	return tools[0]
}
