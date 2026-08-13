# go/performance — mission and scope

Source of truth for what this adversary is *for*.

- **Package:** `go-performance`
- **Factory routing:** human PR comments are attributed to this adversary only when they match **In scope**.
- **Languages / surfaces:** Go performance

## Mission

Review Go for hot-path performance defects and resource amplification (defer-in-loop, per-request clients, regexp compile, quadratic strings, and expensive shared caches keyed by request-controlled values).

## In scope (fair miss if humans raised it and we did not)

- defer in tight loops
- Per-request HTTP clients / connection thrash
- Hot-path regexp compilation
- Quadratic string building
- Request-controlled cookie/header/query/path keys that can multiply expensive cache misses and retained entries without a hard cardinality bound

For request-keyed caches, a TTL alone is not a cardinality bound. Structurally proven fixed key allowlists, request-local maps, and explicit entry/weight-limited eviction are not misses. A method name such as `Allow`, `Admit`, or `Take` is not treated as admission proof without verifiable bounded behavior.

## Out of scope (not a miss for this adversary)

- Correctness-only without performance
- Non-Go

## Factory grading rule

- **In scope + human raised it + this adversary did not surface it** → real miss → suggested issue for **this** package
- **Out of scope** → do not grade as a miss for this adversary
- **Better fit for another adversary** → route there; do not double-count as a miss here
- **Unclear** → prefer out-of-scope for grading
