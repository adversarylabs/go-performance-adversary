package poor

func normalize(inputs []string) []string {
	for index, value := range inputs {
		inputs[index] = string([]byte(value))
	}
	return inputs
}
