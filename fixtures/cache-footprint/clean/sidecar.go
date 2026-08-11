package cachefootprint

type EndpointAddress struct {
	IP [16]byte
}

type endpointSnapshot struct {
	Addresses []EndpointAddress
	Zones     map[string]string
}

// Optional topology metadata uses sidecar storage, so the default cache
// element layout stays unchanged.
func buildSnapshot(addresses []EndpointAddress, zones map[string]string) endpointSnapshot {
	return endpointSnapshot{Addresses: addresses, Zones: zones}
}
