# CUPID architecture enforcement

CUPID describes properties rather than a recipe: code should be composable,
Unix-like, predictable, idiomatic, and domain-based. This analyzer enforces the
structural parts that TypeScript dependency graphs can establish reliably.

## What is enforced

- **Composable:** module, domain, and workspace-package dependency graphs must
  be acyclic. Cross-domain wiring belongs in explicit composition roots.
- **Unix-like:** surface and shape budgets expose grab bags and pass-through
  indirection.
- **Predictable:** TypeScript resolution is cached once per graph and emitted in
  a deterministic snapshot; SCCs, anchors, and canonical cycle paths are stable.
- **Idiomatic:** package `exports`/`imports`, tsconfig paths, public facades, and
  reason-carrying exceptions use normal TypeScript and Node contracts.
- **Domain-based:** every production module has one owner; cross-domain callers
  enter through configured entrypoints and cannot trigger another domain by a
  side-effect-only import.

## Ownership precedence

When `domains` is configured, module ownership resolves in this order:

1. A matching `compositionRoots` path is composition, not domain code.
2. The longest matching `domainOwnership.path` supplies an explicit owner.
3. The longest matching `domains[].roots` path supplies an inferred owner.
4. Anything else receives `require-domain-ownership`.

Paths are project-relative, segment-aligned, and may not escape the project.
Domain names and roots must be unique. Every entrypoint must sit inside one of
its domain's roots. Tests are excluded from domain enforcement.

## Boundary behavior

A production import from one domain to another creates a domain edge. It must
land on one of the destination domain's `entrypoints`; a deep import receives
`no-domain-boundary-bypass`. Cyclic domain SCCs receive one deterministic
`no-domain-cycle` finding. A side-effect-only import such as
`import "../billing/register.js"` also receives
`no-cross-domain-side-effect`; move that wiring to a composition root.

Configuration is intentionally explicit. There are no guessed domain names,
filesystem globs, or magic `shared` exemptions. Every exception either names a
boundary with a reason or is visible in the waiver ledger.
