import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectDependencies } from "./index";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function project(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "import-analysis-"));
  temporaryDirectories.push(directory);
  for (const [file, contents] of Object.entries(files)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return directory;
}

test("recursively follows imports and re-exports, deduplicating cycles and excluding all entries", () => {
  const cwd = project({
    "first.tsx": 'import { value } from "./barrel"; import type { Shared } from "./shared"; const shared: Shared = {}; console.log(value, shared);',
    "second.ts": 'export { value } from "./barrel";',
    "barrel/index.ts": 'export { value } from "../deep"; export * from "../shared";',
    "deep.ts": 'import "./first"; import "./second"; export const value = 1;',
    "shared.d.ts": "export interface Shared {}",
    "unrelated.ts": "",
  });

  expect(collectDependencies(["first.tsx", "second.ts"], cwd)).toEqual([
    "barrel/index.ts",
    "deep.ts",
    "shared.d.ts",
  ]);
});

test("respects extended configs, aliases, and the nearest config across project boundaries", () => {
  const cwd = project({
    "base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@shared/*":["shared/*"]}}}',
    "tsconfig.json": '{"extends":"./base.json"}',
    "app.ts": 'import "@shared/value"; import "./nested/entry";',
    "shared/value.ts": 'export * from "./leaf.js";',
    "shared/leaf.ts": "",
    "nested/tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@local/*":["src/*"]}}}',
    "nested/entry.ts": 'import "@local/value";',
    "nested/src/value.ts": "",
  });

  expect(collectDependencies(["app.ts"], cwd)).toEqual([
    "nested/entry.ts",
    "nested/src/value.ts",
    "shared/leaf.ts",
    "shared/value.ts",
  ]);
});

test("follows literal dynamic imports, require, import-equals, and import types", () => {
  const cwd = project({
    "entry.cts": [
      'import legacy = require("./legacy.cjs");',
      "void legacy;",
      'const load = () => import("./dynamic.mjs");',
      'const required = require("./required");',
      'type T = import("./types").T;',
      'const computed = import(name);',
      '// import "./not-real";',
      'const text = \'require("./not-real-either")\';',
    ].join("\n"),
    "legacy.cts": "",
    "dynamic.mts": "",
    "required.ts": "",
    "types.ts": "export type T = string;",
  });

  expect(collectDependencies(["entry.cts"], cwd)).toEqual([
    "dynamic.mts", "legacy.cts", "required.ts", "types.ts",
  ]);
});

test("follows local JavaScript and workspace symlinks, excluding installed package files and assets", () => {
  const cwd = project({
    "entry.ts": 'import "./bridge.js"; import "workspace"; import "installed"; import "node:fs"; import "./style.css"; import "./data.json";',
    "bridge.js": 'export * from "./through-js";',
    "through-js.ts": "",
    "workspace/package.json": '{"name":"workspace","types":"index.ts"}',
    "workspace/index.ts": 'export * from "./leaf";',
    "workspace/leaf.ts": "",
    "node_modules/installed/package.json": '{"name":"installed","types":"index.d.ts"}',
    "node_modules/installed/index.d.ts": 'export * from "./internal";',
    "node_modules/installed/internal.d.ts": "",
    "style.css": "",
    "data.json": "{}",
  });
  symlinkSync(join(cwd, "workspace"), join(cwd, "node_modules/workspace"), "dir");

  expect(collectDependencies(["entry.ts"], cwd)).toEqual([
    "through-js.ts", "workspace/index.ts", "workspace/leaf.ts",
  ]);
});

test("follows triple-slash file and local type references", () => {
  const cwd = project({
    "tsconfig.json": '{"compilerOptions":{"typeRoots":["./types"]}}',
    "entry.ts": '/// <reference path="./globals.d.ts" />\n/// <reference types="custom" />',
    "globals.d.ts": 'import "./leaf";',
    "leaf.d.ts": "",
    "types/custom/index.d.ts": "",
  });

  expect(collectDependencies(["entry.ts"], cwd)).toEqual([
    "globals.d.ts", "leaf.d.ts", "types/custom/index.d.ts",
  ]);
});

test("respects NodeNext conditional package exports for both imports and require", () => {
  const cwd = project({
    "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
    "entry.mts": 'import "workspace"; const other = require("workspace");',
    "workspace/package.json": '{"name":"workspace","exports":{".":{"import":"./esm.mts","require":"./cjs.cts"}}}',
    "workspace/esm.mts": "",
    "workspace/cjs.cts": "",
    "node_modules/.keep": "",
  });
  symlinkSync(join(cwd, "workspace"), join(cwd, "node_modules/workspace"), "dir");

  expect(collectDependencies(["entry.mts"], cwd)).toEqual([
    "workspace/cjs.cts", "workspace/esm.mts",
  ]);
});

test("follows only used named exports through nested barrels, preserving explicit side effects", () => {
  const cwd = project({
    "entry.ts": 'import { Public as Used, Unused } from "./index"; import type { Shape } from "./index"; const shape: Shape = {}; console.log(Used, shape);',
    "index.ts": 'import "./setup"; import {} from "./empty-import"; export { Inner as Public } from "./nested"; export { Unused } from "./unused"; export type { Shape } from "./shape";',
    "nested.ts": 'export { default as Inner } from "./used"; export * from "./unrelated";',
    "used.ts": 'import { helper } from "./helper"; export default () => helper();',
    "helper.ts": "export const helper = () => 1;",
    "shape.ts": "export interface Shape {}",
    "setup.ts": 'import "./setup-leaf";',
    "setup-leaf.ts": "",
    "empty-import.ts": "",
    "unused.ts": 'import "./missing-but-unused"; export const Unused = 1;',
    "unrelated.ts": 'export const Other = 2;',
  });
  expect(collectDependencies(["entry.ts"], cwd)).toEqual([
    "empty-import.ts", "helper.ts", "index.ts", "nested.ts", "setup-leaf.ts", "setup.ts", "shape.ts", "used.ts",
  ]);
});

test("resolves export-star chains without including sibling barrels or their side effects", () => {
  const cwd = project({
    "entry.ts": 'import { used } from "./index"; used();',
    "index.ts": 'export * from "./unused"; export * from "./middle";',
    "middle.ts": 'export * from "./used"; export { irrelevant } from "./irrelevant";',
    "used.ts": "export function used() {}",
    "unused.ts": 'import "./unused-effect"; export const unused = 1;',
    "unused-effect.ts": "",
    "irrelevant.ts": "export const irrelevant = 1;",
  });
  expect(collectDependencies(["entry.ts"], cwd)).toEqual(["index.ts", "middle.ts", "used.ts"]);
});

test("follows local import/export aliases and dependencies of the selected declaration only", () => {
  const cwd = project({
    "entry.ts": 'import { Public } from "./index"; console.log(Public);',
    "index.ts": 'import { Original as Local } from "./used"; import { Other } from "./unused"; export { Local as Public, Other };',
    "used.ts": 'import { helper } from "./helper"; import { other } from "./other"; const local = () => helper(); export const Original = () => local(); export const Unused = () => other();',
    "helper.ts": "export const helper = () => 1;",
    "unused.ts": "export const Other = 2;",
    "other.ts": "export const other = () => 3;",
  });
  expect(collectDependencies(["entry.ts"], cwd)).toEqual(["helper.ts", "index.ts", "used.ts"]);
});

test("tracks multiple namespace members, aliases, and destructuring; namespace escapes include all exports", () => {
  const cwd = project({
    "entry.ts": 'import * as api from "./index"; api.first(); console.log(api["second"]); const { first: alias } = api; alias();',
    "escaped.ts": 'import * as api from "./index"; console.log(api);',
    "index.ts": 'export { first } from "./first"; export { second } from "./second"; export { third } from "./third";',
    "first.ts": "export function first() {}",
    "second.ts": "export const second = 2;",
    "third.ts": "export const third = 3;",
  });
  expect(collectDependencies(["entry.ts"], cwd)).toEqual(["first.ts", "index.ts", "second.ts"]);
  expect(collectDependencies(["escaped.ts"], cwd)).toEqual(["first.ts", "index.ts", "second.ts", "third.ts"]);
});

test("unions export requests from multiple entries and terminates with cyclic star exports", () => {
  const cwd = project({
    "first.ts": 'import { A } from "./index"; console.log(A);',
    "second.ts": 'import { B } from "./index"; console.log(B);',
    "index.ts": 'export * from "./cycle"; export { A } from "./a"; export { Unused } from "./unused";',
    "cycle.ts": 'export * from "./index"; export { B } from "./b";',
    "a.ts": "export const A = 1;",
    "b.ts": "export const B = 2;",
    "unused.ts": "export const Unused = 3;",
  });
  expect(collectDependencies(["first.ts", "second.ts"], cwd)).toEqual(["a.ts", "b.ts", "cycle.ts", "index.ts"]);
});

test("uses bound symbols rather than matching identifier text, including shorthand and type references", () => {
  const cwd = project({
    "entry.ts": 'import { used, shadowed } from "./index"; import type { Shape } from "./index"; function f(shadowed: number) { return shadowed; } const value: Shape = { used };',
    "index.ts": 'export { used } from "./used"; export { shadowed } from "./unused"; export type { Shape } from "./shape";',
    "used.ts": "export const used = 1;",
    "unused.ts": "export const shadowed = 2;",
    "shape.ts": "export interface Shape { used: number; }",
  });
  expect(collectDependencies(["entry.ts"], cwd)).toEqual(["index.ts", "shape.ts", "used.ts"]);
});

test("narrows import types and destructured literal module loads", () => {
  const cwd = project({
    "entry.ts": 'type T = import("./index").Shape; const { used } = require("./index"); const { other: renamed } = await import("./index");',
    "index.ts": 'export type { Shape } from "./shape"; export { used } from "./used"; export { other } from "./other"; export { unused } from "./unused";',
    "shape.ts": "export interface Shape {}",
    "used.ts": "export const used = 1;",
    "other.ts": "export const other = 2;",
    "unused.ts": "export const unused = 3;",
  });
  expect(collectDependencies(["entry.ts"], cwd)).toEqual(["index.ts", "other.ts", "shape.ts", "used.ts"]);
});

test("preserves CommonJS export-equals modules and forwarded namespaces", () => {
  const cwd = project({
    "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","esModuleInterop":true}}',
    "entry.cts": 'import legacy from "./legacy.cjs"; import { api } from "./index.cjs"; legacy(); api.used();',
    "legacy.cts": 'import { helper } from "./helper.cjs"; const legacy = () => helper(); export = legacy;',
    "helper.cts": "export const helper = () => 1;",
    "index.cts": 'export * as api from "./api.cjs"; export { other } from "./other.cjs";',
    "api.cts": "export const used = () => 1;",
    "other.cts": "export const other = 2;",
  });
  expect(collectDependencies(["entry.cts"], cwd)).toEqual([
    "api.cts", "helper.cts", "index.cts", "legacy.cts",
  ]);
});

test("resolves external export-star symbols without printing package files or unrelated local exports", () => {
  const cwd = project({
    "entry.ts": 'import type { External } from "./index"; const value: External = {};',
    "index.ts": 'export * from "./bridge"; export * from "./unused"; export * from "./missing-unused";',
    "bridge.ts": 'export * from "installed";',
    "unused.ts": "export const unused = 1;",
    "node_modules/installed/package.json": '{"name":"installed","types":"index.d.ts"}',
    "node_modules/installed/index.d.ts": "export interface External {}",
  });
  expect(collectDependencies(["entry.ts"], cwd)).toEqual(["bridge.ts", "index.ts"]);
});

test("reports invalid inputs, broken configuration, and unresolved dependencies", () => {
  const cwd = project({
    "entry.ts": 'import "./missing";',
    "not-typescript.js": "",
  });
  expect(() => collectDependencies([], cwd)).toThrow("Usage:");
  expect(() => collectDependencies(["missing.ts"], cwd)).toThrow("Not an existing TypeScript file");
  expect(() => collectDependencies(["not-typescript.js"], cwd)).toThrow("Not an existing TypeScript file");
  expect(() => collectDependencies(["entry.ts"], cwd)).toThrow('Cannot resolve "./missing"');

  writeFileSync(join(cwd, "tsconfig.json"), '{"extends":"./missing-config.json"}');
  expect(() => collectDependencies(["entry.ts"], cwd)).toThrow("missing-config.json");
});

test("accepts explicit entries outside tsconfig include patterns and handles dependency-free files", () => {
  const cwd = project({
    "tsconfig.json": '{"include":["absent/**/*.ts"]}',
    "entry.ts": "export const value = 1;",
  });
  expect(collectDependencies(["entry.ts", "./entry.ts"], cwd)).toEqual([]);
});

test("recursively analyzes directory entries and excludes all entries from the results", () => {
  const cwd = project({
    "feature/entry.ts": 'import "./nested/other"; import "../shared";',
    "feature/nested/other.tsx": 'import "../../shared"; import "../../second.mjs";',
    "feature/nested/types.d.ts": 'import "../../types";',
    "feature/style.css": "",
    "feature/node_modules/ignored/broken.ts": 'import "./missing";',
    "shared.ts": "",
    "second.mts": "",
    "types.d.ts": "",
  });
  symlinkSync(join(cwd, "feature"), join(cwd, "feature/nested/cycle"), "dir");
  symlinkSync(join(cwd, "feature/nested"), join(cwd, "feature/linked"), "dir");

  expect(collectDependencies(["feature", "feature/nested/other.tsx"], cwd)).toEqual([
    "second.mts", "shared.ts", "types.d.ts",
  ]);
});

test("accepts shell-expanded mixed paths and empty directories while rejecting missing entries", () => {
  const cwd = project({
    "feature/entry.ts": 'import "../shared";',
    "feature/nested/entry.cts": 'import "../../second";',
    "feature/style.css": "",
    "shared.ts": "",
    "second.ts": "",
    "empty/.keep": "",
  });
  expect(collectDependencies(["feature/entry.ts", "feature/nested", "feature/style.css"], cwd)).toEqual([
    "second.ts", "shared.ts",
  ]);
  expect(collectDependencies(["feature/entry.ts", "feature/style.css"], cwd)).toEqual(["shared.ts"]);
  expect(collectDependencies(["empty"], cwd)).toEqual([]);
  expect(() => collectDependencies(["empty", "missing"], cwd)).toThrow("missing");
  expect(() => collectDependencies(["feature/style.css"], cwd)).toThrow("Not an existing TypeScript file");
});

test("CLI prints only paths on success, help on request, and errors without partial output", () => {
  const cwd = project({
    "entry.ts": 'import "./dependency";',
    "other.tsx": 'import "./dependency"; import "./nested";',
    "dependency.ts": "",
    "nested.ts": "",
    "broken.ts": 'import "./dependency"; import "./missing";',
    "feature/entry.ts": 'import "../dependency";',
    "feature/nested/entry.ts": 'import "../../nested";',
    "feature/style.css": "",
  });
  const run = (...args: string[]) => Bun.spawnSync({
    cmd: [process.execPath, "run", join(import.meta.dir, "index.ts"), ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const success = run("entry.ts", "other.tsx");
  expect(success.exitCode).toBe(0);
  expect(success.stdout.toString()).toBe("dependency.ts\nnested.ts\n");
  expect(success.stderr.toString()).toBe("");

  const folder = run("feature/entry.ts", "feature/nested", "feature/style.css");
  expect(folder.exitCode).toBe(0);
  expect(folder.stdout.toString()).toBe("dependency.ts\nnested.ts\n");
  expect(folder.stderr.toString()).toBe("");

  const failure = run("broken.ts");
  expect(failure.exitCode).toBe(1);
  expect(failure.stdout.toString()).toBe("");
  expect(failure.stderr.toString()).toContain('Cannot resolve "./missing"');

  const missingArguments = run();
  expect(missingArguments.exitCode).toBe(1);
  expect(missingArguments.stderr.toString()).toContain("Usage:");

  const help = run("--help");
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("Usage:");
});
