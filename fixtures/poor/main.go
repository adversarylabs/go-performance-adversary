package poor

import (
	"os"
)

func readAll(paths []string) error {
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_ = f
	}
	return nil
}
