package excellent

import (
	"regexp"
	"strings"
)

var tokenRe = regexp.MustCompile(`^[a-z]+$`)

func collect(inputs []string) string {
	var b strings.Builder
	b.Grow(len(inputs) * 8)
	result := make([]string, 0, len(inputs))
	for _, input := range inputs {
		if tokenRe.MatchString(input) {
			result = append(result, input)
			b.WriteString(input)
		}
	}
	return b.String()
}
