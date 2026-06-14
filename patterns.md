# Design Patterns

## Offloading Third-Party Scripts via Proxies (Partytown Pattern)
- **Concept**: Offload synchronous/blocking script tasks (like analytics scripts that use `window`, `document`, and cookies) to background Web Workers by intercepts using JavaScript Proxies.
- **Benefits**: Maximizes main-thread responsiveness and scores 100 on PageSpeed/Lighthouse by shielding UI updates from non-critical third-party execution.
- **Proxy Sync Mechanism**: Uses synchronous communication via blocking `Atomics` or synchronous `XMLHttpRequests` between the worker thread and the main thread, enabling third-party scripts to access standard browser APIs as if they were running on the main thread.

## Rich Hickey Gap Analysis
- **Definition**: A rigorous process of comparing old dependencies/features/architecture to newer ones using structured gap tables, analyzing complexity vs. utility, and arriving at weighted recommendation actions.
- **Application**: Useful before executing any major package migrations to avoid integration breaking changes.
