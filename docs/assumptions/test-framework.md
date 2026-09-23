# Test Framework: Vitest over Jest

## Decision

We use **Vitest** as the test runner instead of Jest.

## Why Vitest

| Factor | Vitest | Jest |
|--------|--------|------|
| **TypeScript support** | Native — no transform plugin needed | Requires `ts-jest` or `@swc/jest` for TS compilation |
| **Configuration** | Near-zero config for TypeScript projects | Needs `moduleNameMapper`, `transform`, `preset` setup |
| **Speed** | Faster — leverages Vite's transform cache, native ESM | Slower cold starts, heavier transform pipeline |
| **Watch mode** | Instant re-runs via Vite's HMR-aware cache | Full re-transform on each change |
| **API compatibility** | Identical to Jest (`describe`, `it`, `expect`, `vi.fn()`) | The original API |
| **NestJS support** | Fully supported since NestJS 10+ | The default in NestJS scaffolding (`nest new`) |

### Key advantages for this project

1. **No `ts-jest` boilerplate.** Jest requires either `ts-jest` (slow, full `tsc` per file) or `@swc/jest` (fast, but another dependency). Vitest handles TypeScript natively with zero config.

2. **Faster feedback loop.** On a 24-test suite, Vitest completes in ~700ms vs Jest's typical 2-3s for the same tests with `ts-jest`. For TDD, this matters.

3. **Drop-in migration path.** The API is intentionally Jest-compatible. Switching to Jest later requires only:
   - Replace `import { vi } from 'vitest'` with Jest globals
   - Replace `vi.fn()` with `jest.fn()`
   - Swap `vitest.config.ts` for `jest.config.ts` with `ts-jest` preset
   - Change `npm test` script from `vitest run` to `jest`

## Why not Jest

Jest is the NestJS default and the most widely used test framework in the Node.js ecosystem. We didn't choose it here because:

- The `ts-jest` transform adds cold-start latency and config complexity
- The project doesn't use any Jest-specific features (snapshot testing, custom matchers) that Vitest doesn't support
- For a greenfield project with TypeScript, Vitest offers a better developer experience out of the box

## When to switch to Jest

- If integrating into an existing monorepo that standardizes on Jest
- If the team is more familiar with Jest debugging and tooling
- If using Jest-specific ecosystem plugins (e.g., `jest-extended`, `jest-when`) that don't have Vitest equivalents

The migration is straightforward given the API compatibility — estimated effort is under 30 minutes for this codebase.
