# Go Performance adversary

Go Performance reviews material allocation, copying, retention, buffering, and contention risk with evidence rather than micro-optimization style advice.

The review focuses on invariant regular-expression compilation in loops, redundant byte/string copies, and request-controlled expensive caches without cardinality bounds.

## Fixtures and calibration

Five graded fixtures own expected review snapshots. The 61-repository corpus calibrates allocation and hot-path judgment.

## Automatic detection

`adversary auto` selects Go Performance for changed Go source. Runtime benchmark, profile, and call-path evidence will later make selection more conservative.

## Development

Run `npm test`, `adversary validate .`, and `adversary pack --check .`.
