package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

var httpc = &http.Client{Timeout: 3 * time.Minute}

// userAgent начинается с hostpink: сервер по нему включает ANSI-цвета, как для curl.
func userAgent() string {
	return fmt.Sprintf("hostpink/%s (%s/%s)", version, runtime.GOOS, runtime.GOARCH)
}

func get(u string) (*http.Response, error) {
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent())
	resp, err := httpc.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		resp.Body.Close()
		msg := strings.TrimSpace(string(body))
		if msg == "" || strings.HasPrefix(msg, "<") {
			msg = resp.Status
		}
		return nil, fmt.Errorf("%s: %s", u, msg)
	}
	return resp, nil
}

func getBytes(u string) ([]byte, error) {
	resp, err := get(u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func getJSON(u string, v any) error {
	b, err := getBytes(u)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// textURL добавляет ?text: сервер отдаёт тот же отчёт, что и curl.
func textURL(path string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return site + path + sep + "text"
}

// pathArg экранирует ввод для пути, но оставляет «/» (префиксы вида 1.1.1.0/24).
func pathArg(s string) string {
	parts := strings.Split(strings.TrimSpace(s), "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

// Потоковое чтение: отчёты host.pink приходят кусками, показываем их по мере прихода.
type chunkMsg struct {
	id   int
	data string
}

type streamDoneMsg struct {
	id  int
	err error
}

func stream(id int, u string) tea.Cmd {
	return func() tea.Msg {
		go func() {
			resp, err := get(u)
			if err != nil {
				prog.Send(streamDoneMsg{id, err})
				return
			}
			defer resp.Body.Close()
			buf := make([]byte, 16*1024)
			for {
				n, err := resp.Body.Read(buf)
				if n > 0 {
					prog.Send(chunkMsg{id, string(buf[:n])})
				}
				if err == io.EOF {
					prog.Send(streamDoneMsg{id, nil})
					return
				}
				if err != nil {
					prog.Send(streamDoneMsg{id, err})
					return
				}
			}
		}()
		return nil
	}
}

type myIP struct {
	IP      string `json:"ip"`
	ASN     int    `json:"asn"`
	Org     string `json:"org"`
	Country string `json:"country"`
	City    string `json:"city"`
	Colo    string `json:"colo"`
}

type ipMsg struct {
	ip  *myIP
	err error
}

func fetchIP() tea.Cmd {
	return func() tea.Msg {
		var m myIP
		if err := getJSON(site+"/ip?json", &m); err != nil {
			return ipMsg{nil, err}
		}
		return ipMsg{&m, nil}
	}
}
