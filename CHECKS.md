# Checks — what go-performance detects

This file is the **public audit list** of detectors for the **go-performance** adversary. High-confidence performance defects in Go with file:line evidence — not a micro-optimization linter. Performance advice is the easiest place to lose trust with contextless nitpicks, so this catalog is deliberately small and biased toward patterns that cause production incidents (resource exhaustion, connection-pool loss, O(n²) blowups), not nanosecond wins.

Runtime source of truth: [`src/domain.ts`](src/domain.ts) / [`src/analyze.ts`](src/analyze.ts).

**Scope:** `*.go` excluding vendored trees and `_test.go` (benchmark code intentionally does odd things).

**Precision stance:** No preallocation nits, no `fmt.Sprintf`-vs-concat micro advice, no "use sync.Pool" suggestions. Fire on patterns that are wrong at any scale (defer-in-loop resource pileups, per-request clients), wrong at data scale (quadratic string building), or that let request-controlled cardinality amplify expensive work and retained cache state.

Public grounding: Go wiki CommonMistakes, gocritic/staticcheck analyzers (`hugeParam`, `rangeValCopy`), and net/http connection-pooling documentation.

---

## High

### `go-perf.defer-in-loop`

| | |
| --- | --- |
| **What** | `defer` inside a loop — deferred calls pile up until the *function* returns, not the iteration |
| **Why** | The classic form (`os.Open` + `defer f.Close()` per iteration) exhausts file descriptors on large inputs; locks held via deferred Unlock serialize the whole loop |
| **Looks for** | `defer` statements lexically inside `for`/`range` bodies, especially deferring `Close`/`Unlock`/`Body.Close` on per-iteration resources |
| **Stays quiet when** | Loop body is extracted into a function (defer scope is per-call); loop is provably tiny and fixed (small const bound); defer intentionally accumulates (rare, documented) |
| **Public examples** | Go wiki CommonMistakes; "too many open files" incident writeups tracing to defer-in-loop |
| **Remediation** | Extract the loop body into a function so defers run per iteration, or close explicitly at end of iteration |

### `go-perf.http-client-per-request`

| | |
| --- | --- |
| **What** | New `http.Client`/`http.Transport` constructed per request or per loop iteration |
| **Why** | Throws away the connection pool: every call pays TCP+TLS setup, and closed connections pile up in TIME_WAIT — a recurring port-exhaustion outage class |
| **Looks for** | `&http.Client{...}` / `&http.Transport{...}` composite literals inside handler funcs, loops, or per-call helper functions invoked per request |
| **Stays quiet when** | Client built once (package var, struct field, constructor) and reused; per-request client intentionally isolates credentials with a shared Transport |
| **Public examples** | net/http docs: "Clients and Transports are safe for concurrent use and should be reused"; TIME_WAIT exhaustion postmortems |
| **Remediation** | Build one Client (or one Transport) at startup and share it |

### `go-perf.regexp-compile-in-hot-path`

| | |
| --- | --- |
| **What** | `regexp.MustCompile` / `regexp.Compile` inside a loop or request handler |
| **Why** | Compilation is orders of magnitude more expensive than matching; per-request compilation of a constant pattern is pure waste and shows up in real profiles |
| **Looks for** | `regexp.(Must)Compile` with a **constant** pattern lexically inside loops or handler functions |
| **Stays quiet when** | Compiled once at package level / init / constructor; pattern is genuinely dynamic (built from input — then the finding is different and out of scope here) |
| **Public examples** | Standard Go review feedback; staticcheck-adjacent guidance |
| **Remediation** | Hoist to `var re = regexp.MustCompile(...)` at package scope |

---

## Medium

### `go-perf.string-concat-loop`

| | |
| --- | --- |
| **What** | String built with `+=` inside a loop over unbounded data |
| **Why** | Each iteration reallocates and copies the whole string — O(n²) on input size; fine at 10 items, an outage at 10 million |
| **Looks for** | `s += ...` (or `s = s + ...`) on string vars inside `for`/`range` whose source is a slice/channel/scanner of unbounded size |
| **Stays quiet when** | `strings.Builder` / `bytes.Buffer` / `strings.Join` used; loop bound is a small constant; building short fixed-part strings |
| **Public examples** | `strings.Builder` docs exist for exactly this; standard Go review comment |
| **Remediation** | Use `strings.Builder` (with `Grow` when size is known) |

### `go-perf.large-value-copy`

| | |
| --- | --- |
| **What** | Large structs (≥ ~128 bytes) copied per iteration via `range` value or passed by value in hot signatures |
| **Why** | Copy cost scales with struct size × iteration count; invisible in code review, visible in profiles |
| **Looks for** | `for _, v := range xs` where element type exceeds the size threshold; parameters over the threshold on functions called in loops — gocritic `rangeValCopy`/`hugeParam` parity with a conservative threshold |
| **Stays quiet when** | Small structs (below threshold); copies required for mutation-safety; cold paths (LLM judgment on call frequency) |
| **Public examples** | gocritic `hugeParam` / `rangeValCopy` analyzers |
| **Remediation** | Range over indices (`for i := range xs`) or use pointer slices where ownership allows |

### `go-perf.cache-element-footprint-claim`

| | |
| --- | --- |
| **What** | A changed cache element gains a descriptor-bearing `string`, slice, or map field while the same changed file claims the default cache stays slim, compact, or unchanged |
| **Why** | A zero-value descriptor still occupies space in every containing struct value; conditional assignment does not recover the old per-element layout |
| **Looks for** | All three pieces of changed-file evidence: the new descriptor-bearing field, the struct stored by value in a slice/map, and an explicit cache-footprint claim in a nearby changed comment |
| **Stays quiet when** | The collection is an ordinary registry/configuration structure; there is no explicit unchanged-footprint claim; metadata lives in opt-in sidecar storage; the element is stored by pointer |
| **Public examples** | CoreDNS review of optional zonal metadata added to each cached endpoint address |
| **Remediation** | Keep opt-in metadata in sidecar storage, or measure and accept the per-entry cost and correct the footprint claim |

### `go-perf.request-keyed-cache-amplification`

| | |
| --- | --- |
| **What** | A cookie, header, query, or path value (or a direct deterministic derivation) keys a package- or receiver-owned cache whose miss path performs remote, file, or database work before inserting a new entry |
| **Why** | A caller can manufacture distinct keys to multiply backend work and retained memory. A TTL limits entry age, but does not bound how many keys can be admitted during the TTL window |
| **Looks for** | Structural cross-file evidence joining an actual `net/http.Request` source, key propagation, lookup/miss path, key-dependent material work, and map insertion. A full cache scan under a shared lock strengthens the evidence but is not required |
| **Stays quiet when** | The map or receiver is proven request-local; a callback is stored rather than proven to execute; the value is not request controlled; a locally resolved helper does not perform material miss work; keys come from a structurally proven fixed allowlist; or the cache has a hard entry/weight limit with rejection or eviction (including an explicit bounded LRU). A method named `Allow`, `Admit`, or `Take` is not proof of bounded admission by itself. |
| **Public examples** | Grafana preview-assets cache: forged `grafana_preview_assets` cookie values caused distinct bucket fetches and package-cache entries; fixed with a 64-entry expiring LRU |
| **Remediation** | Put a hard entry/weight bound and eviction on the cache, or constrain/admit request keys before performing the miss work |

### `go-perf.readall-large-source`

| | |
| --- | --- |
| **What** | `io.ReadAll` on response bodies or files that can be large, where the consumer streams anyway |
| **Why** | Loads entire payload into memory before processing; the common `io.ReadAll` → `json.Unmarshal` pair doubles peak memory vs `json.NewDecoder` |
| **Looks for** | LLM-gated: `io.ReadAll(resp.Body)` / `io.ReadAll(f)` where the result feeds a streaming-capable consumer (json/xml decode, io.Copy, line scanning) |
| **Stays quiet when** | Source is provably small (config files, capped by MaxBytesReader/LimitReader); bytes genuinely needed in full (checksums, retry-with-body) |
| **Public examples** | `json.NewDecoder` vs ReadAll guidance; OOM postmortems on unbounded response reads |
| **Remediation** | Stream with `json.NewDecoder` / `io.Copy`; cap with `io.LimitReader` when a bound exists |

---

## Out of scope (owned elsewhere)

| Concern | Owner |
| --- | --- |
| Unbounded request-body reads (server DoS) | `go/http` (`body.unbounded-read`) |
| N+1 queries, missing prepared statements | `go/database` |
| Busy-select loops, `time.After` in loops, unbounded goroutines | `go/concurrency` |
| Missing timeouts (client/server) | `go/http` |
| Micro-optimizations (prealloc, Sprintf, interface boxing) | none — deliberately not detected |

---

## Release gates (repo checklist)

- [ ] `npm test`
- [ ] `adversary validate .`
- [ ] `adversary pack --check .`
- [ ] Five graded fixture snapshots match
- [ ] Benchmark corpus contains 50–100 unique, reachable repositories
- [ ] Runtime artifact executes without `node_modules`
- [ ] No scanned repository writes or model calls
