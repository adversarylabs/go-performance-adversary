# Checks

| Rule | Severity | Scans for |
| --- | --- | --- |
| `go-perf.cache-element-footprint-claim` | Medium | A changed cache element gains a descriptor-bearing `string`, slice, or map field while the same changed file claims the default cache stays slim, compact, or unchanged |
| `go-perf.defer-in-loop` | High | `defer` inside a loop — deferred calls pile up until the *function* returns, not the iteration |
| `go-perf.environment-process-inspection-per-request` | Medium | A request/RPC path resolves environment-specific process identity through procfs-like inspection without a construction-time applicability gate or bounded process-ID cache |
| `go-perf.http-client-per-request` | High | New `http.Client`/`http.Transport` constructed per request or per loop iteration |
| `go-perf.large-value-copy` | Medium | Large structs (≥ ~128 bytes) copied per iteration via `range` value or passed by value in hot signatures |
| `go-perf.regexp-compile-in-hot-path` | High | `regexp.MustCompile` / `regexp.Compile` inside a loop or request handler |
| `go-perf.request-keyed-cache-amplification` | Medium | A cookie, header, query, or path value (or a direct deterministic derivation) keys a package- or receiver-owned cache whose miss path performs remote, file, or database work before inserting a new entry |
| `go-perf.string-concat-loop` | Medium | A string accumulator declared outside an unbounded loop grows via `+=` or self-referential assignment; temporary concatenations, per-iteration resets, numeric accumulation, and locally proven small fixed loops stay quiet |
