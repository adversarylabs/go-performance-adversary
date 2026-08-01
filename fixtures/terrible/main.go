package terrible

import (
	"net/http"
	"regexp"
)

func match(pattern string, inputs []string) int {
	count := 0
	for _, input := range inputs {
		if regexp.MustCompile(pattern).MatchString(input) {
			count++
		}
	}
	return count
}

func ServeHTTP(w http.ResponseWriter, r *http.Request) {
	client := &http.Client{}
	resp, err := client.Get("https://example.com" + r.URL.Path)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer resp.Body.Close()
	_ = resp
}
