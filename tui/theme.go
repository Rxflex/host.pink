package main

import (
	"image/color"
	"strings"

	"charm.land/lipgloss/v2"
)

// Палитра «Лакмус» с host.pink: подобрана так, чтобы читаться и на тёмном, и на светлом терминале.
var (
	cPink   = lipgloss.Color("#FF4FA3")
	cPink2  = lipgloss.Color("#E6007A")
	cViolet = lipgloss.Color("#9C6EEA")
	cDim    = lipgloss.Color("#9A8497")
	cRule   = lipgloss.Color("#6E5A6C")
	cOK     = lipgloss.Color("#3DDC97")
	cWarn   = lipgloss.Color("#FFB547")
	cBad    = lipgloss.Color("#FF6B5E")

	sPink   = lipgloss.NewStyle().Foreground(cPink)
	sBold   = lipgloss.NewStyle().Bold(true)
	sDim    = lipgloss.NewStyle().Foreground(cDim)
	sOK     = lipgloss.NewStyle().Foreground(cOK)
	sWarn   = lipgloss.NewStyle().Foreground(cWarn)
	sBad    = lipgloss.NewStyle().Foreground(cBad)
	sKey    = lipgloss.NewStyle().Foreground(cPink).Bold(true)
	sChip   = lipgloss.NewStyle().Foreground(cViolet)
	sTitle  = lipgloss.NewStyle().Bold(true).Foreground(cPink)
	sBorder = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(cPink2).Padding(0, 1)
)

// Циклическая палитра для бегущего градиента: розовый → фиолетовый → розовый.
var wave = lipgloss.Blend1D(48, cPink, cViolet, cPink2, cPink)

func waveColor(i int) color.Color {
	n := len(wave)
	return wave[((i%n)+n)%n]
}

// gradient красит строку посимвольно; phase сдвигает волну, шаг задаёт её ширину.
func gradient(s string, phase, step int) string {
	var b strings.Builder
	i := 0
	for _, r := range s {
		if r == ' ' {
			b.WriteRune(r)
		} else {
			b.WriteString(lipgloss.NewStyle().Foreground(waveColor(phase + i*step)).Render(string(r)))
		}
		i++
	}
	return b.String()
}

// Логотип «host.pink» блочным шрифтом в три строки: влезает даже в 40 колонок.
var glyphs = map[rune][3]string{
	'h': {"█  ", "█▀▄", "█ █"},
	'o': {"   ", "█▀█", "█▄█"},
	's': {"   ", "█▀▀", "▄▄█"},
	't': {" ▄ ", "▀█▀", " █▄"},
	'.': {"  ", "  ", "▄ "},
	'p': {"   ", "█▀█", "█▀▀"},
	'i': {"▀", "█", "█"},
	'n': {"   ", "█▀▄", "█ █"},
	'k': {"█  ", "█▄▀", "█ █"},
}

func logoRows() [3]string {
	var rows [3]string
	for _, r := range "host.pink" {
		g := glyphs[r]
		for i := 0; i < 3; i++ {
			rows[i] += g[i] + " "
		}
	}
	return rows
}

// logo рисует логотип с волной; reveal — сколько колонок уже «напечатано» (для заставки).
func logo(phase, reveal int) string {
	rows := logoRows()
	var out []string
	for y, row := range rows {
		var b strings.Builder
		x := 0
		for _, r := range row {
			switch {
			case reveal >= 0 && x >= reveal:
				b.WriteRune(' ')
			case r == ' ':
				b.WriteRune(' ')
			default:
				b.WriteString(lipgloss.NewStyle().Foreground(waveColor(phase + x*2 + y*3)).Render(string(r)))
			}
			x++
		}
		out = append(out, b.String())
	}
	return strings.Join(out, "\n")
}

func logoWidth() int { return lipgloss.Width(logoRows()[0]) }

var spinFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

func badge(text string, c color.Color) string {
	return lipgloss.NewStyle().Foreground(c).Render("● ") + text
}
