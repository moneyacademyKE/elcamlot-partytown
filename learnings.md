# Learnings

## Scoped Package Migration (Partytown)
- **Problem**: Legacy packages like `@builder.io/partytown` are frozen. Maintenance has moved to `@qwik.dev/partytown`.
- **Solution**: Update dependencies to `@qwik.dev/partytown` to ensure ongoing bug fixes, security updates, and performance optimizations.
- **Asset Synchronization**: Partytown relies on background web worker scripts. Upgrading the package requires running the `partytown copylib` command (e.g., `bun run partytown` which targets `public/~partytown`) to copy the newly updated worker files into public assets. Otherwise, the old version's worker script remains active, potentially causing runtime sync issues between the main-thread script and the worker script.
