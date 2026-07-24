package good

func sum(inputs []int) int {
	total := 0
	for _, value := range inputs {
		total += value
	}
	return total
}
