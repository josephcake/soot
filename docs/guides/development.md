# Development

## Toolchain

| Tool       | Version                                         | Notes                                                       |
| ---------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Node.js    | `>=24.11.0`; `.nvmrc` pins `26`                 | 24 and 26 are both LTS lines; CI matrix covers both.        |
| pnpm       | 10 (`packageManager: pnpm@10.34.6`)             | `engine-strict=true` in `.npmrc`.                           |
| TypeScript | 6.0.x                                           | Pinned below 7 because typescript-eslint 8 supports `<6.1`. |
| ESLint     | 10 + typescript-eslint 8 (strict, type-checked) | `eslint-config-prettier` disables style rules.              |
| Prettier   | 3                                               | Formatting is enforced with `format:check`.                 |
| Vitest     | 5                                               | One project per package, plus `repo` for `tests/`.          |

## Scripts (root)

| Script                  | What it does                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm run build`        | `tsc -b` over all project references → each package's `dist/`                                |
| `pnpm run clean`        | Removes build outputs (`tsc -b --clean`)                                                     |
| `pnpm run typecheck`    | No-emit typecheck of all sources, tests, and configs                                         |
| `pnpm run lint`         | ESLint, zero warnings allowed                                                                |
| `pnpm run format`       | Prettier write                                                                               |
| `pnpm run format:check` | Prettier check                                                                               |
| `pnpm run test`         | Vitest, all projects                                                                         |
| `pnpm run ci`           | `scripts/ci.sh`: install (frozen lockfile), typecheck, lint, format check, test, clean build |

Per package: `pnpm --filter @soot/<name> build` / `test`.

## Adding a package

1. Create `packages/<name>/` with `package.json` (name `@soot/<name>`,
   `private`, `MIT`, `build` and `test` scripts), `tsconfig.json` (composite, extends
   `../../tsconfig.base.json`), `src/index.ts`, a test, and a `README.md` stating its status.
2. Add it to the root `tsconfig.json` references.
3. Document it in `docs/guides/architecture.md`.

`tests/repo-structure.test.ts` fails if steps 2 or 3 are skipped.

## CI

`.github/workflows/ci.yml` runs install → typecheck → lint → format check → test → build on
Node 24 and 26 on every push to `main` and every pull request at
[github.com/josephcake/soot](https://github.com/josephcake/soot/actions/workflows/ci.yml)
(first passing run: 2026-11-12, ADR-032). `pnpm run ci` runs the same steps locally.

## Hooks

There are no git hooks. Run `pnpm run ci` before committing.
