# TypeScript dependency CLI

List the transitive TypeScript dependencies used by one or more files.

Install:

```bash
bun install
```

Run from the project you want to analyze:

```bash
bun run /path/to/import-analysis/index.ts \
  packages/manager/src/features/Account/AccountLogins.tsx \
  packages/manager/src/features/Account/AccountLoginsTableRow.tsx
```

When running in this repository, use `bun run index.ts <files...>`.

- Prints one path per line, relative to the working directory, sorted and deduplicated.
- Excludes the supplied entry files, even when a dependency imports them.
- Includes `.ts`, `.tsx`, `.mts`, `.cts`, and declaration files.
- Follows imports, re-exports, type-only imports, literal `import()` and `require()`,
  import-equals declarations, and triple-slash file/type references.
- Tracks referenced symbols: a named import from a barrel includes the barrel and
  only the branches that supply the used exports, including renamed/default
  exports, local import/export forwarding, and nested `export *` chains.
- Omits unused import bindings. Follows the dependencies of selected declarations,
  including their local helpers and type annotations.
- Preserves explicit side-effect imports (`import "./setup"` and `import {} from
  "./setup"`) and top-level expression statements in included modules.
- Traverses local JavaScript dependencies too, but only prints TypeScript paths.
- Uses the nearest `tsconfig.json` for each file, including `extends`, path aliases,
  and module-resolution settings. Without a config, uses bundler resolution.
- Follows local workspace packages, including symlinks, but excludes files that
  resolve inside `node_modules` and TypeScript's implicit standard libraries.
- Handles cycles and shared dependencies without repeating files.

Install the target project's dependencies first. The tool resolves modules without
executing project code. Node built-ins and non-code assets (such as CSS, images, and
JSON) are not printed. Non-code imports without a TypeScript resolution are ignored.
Computed module names such as `import(variable)` cannot be statically followed.
Only explicitly reachable files are included, not unrelated files from `include`,
automatic global types, or implicit JSX runtime imports.

For example, `import { Button } from "./components"; Button();` includes
`components/index.ts` and the files needed by `Button`, not every component
re-exported by that barrel.

Namespace member accesses (`components.Button` or `components["Button"]`),
destructured literal module loads, and qualified import types are narrowed too.
When an entire namespace escapes (for example `consume(components)`), a namespace
is re-exported as a value, or a module load cannot be narrowed statically, all its
exports are included conservatively. CommonJS `export =` / `module.exports`
objects are also followed conservatively.

This is static symbol-dependency analysis, not a bundler or runtime side-effect
analysis. Entry-file declarations are all analyzed; dependency-file declarations
are followed when referenced. Unselected barrel exports and their module
initialization are intentionally excluded, even if a runtime would execute them.
The complete local import graph and any required package declarations are parsed
to resolve export names, but only selected project paths appear in the output.

Missing inputs, invalid configuration, or unresolved used code imports produce an error
on stderr and exit status 1, with no partial list on stdout. Successful runs exit 0;
files without dependencies produce no output. Use `--help` for usage.

Validate:

```bash
bun test
bun run typecheck
```

Requires [Bun](https://bun.com). TypeScript 5.9 supplies the stable compiler API
used for parsing and module resolution.
