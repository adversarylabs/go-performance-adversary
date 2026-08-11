package cachefootprint

type EndpointAddress struct {
	IP [16]byte

	// Zone is populated only when zonal behavior is enabled.
	Zone string
}

type endpointSnapshot struct {
	Addresses []EndpointAddress
}

// buildSnapshot retains optional topology data only when zonal behavior is
// enabled, so the default cache stays exactly as slim as before.
func buildSnapshot(addresses []EndpointAddress) endpointSnapshot {
	return endpointSnapshot{Addresses: addresses}
}
