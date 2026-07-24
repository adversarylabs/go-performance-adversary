package excellent

func collect(inputs []int) []int {
	result := make([]int, 0, len(inputs))
	return append(result, inputs...)
}
