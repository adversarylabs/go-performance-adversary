package cachefootprint

// Plugin is configuration metadata, not a high-cardinality cache element.
type Plugin struct {
	Name    string
	Aliases []string
}

var pluginRegistry = map[string]Plugin{}
