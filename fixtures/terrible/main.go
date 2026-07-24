package terrible

import "regexp"

var cache = make(map[string][]byte)

func match(pattern string, inputs []string) int {
	count := 0
	for _, input := range inputs {
		if regexp.MustCompile(pattern).MatchString(input) {
			count++
		}
	}
	return count
}
