import { readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const typescriptFile = /\.(?:[cm]?ts|tsx)$/i;
const scriptExtension = /^\.(?:[cm]?[jt]s|[jt]sx)$/i;
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const usage = "Usage: bun run index.ts <file.ts|file.tsx|directory> [more files or directories...]";

function isExternal(file: string): boolean {
  return file.split(/[\\/]/).includes("node_modules");
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getNewLine: () => "\n",
  }).trim();
}

export function collectDependencies(entries: readonly string[], cwd = process.cwd()): string[] {
  if (entries.length === 0) {
    throw new Error(usage);
  }

  cwd = ts.sys.realpath?.(resolve(cwd)) ?? resolve(cwd);
  const canonical = (file: string): string => {
    const absolute = resolve(cwd, file);
    return ts.sys.realpath?.(absolute) ?? absolute;
  };
  const roots = new Set<string>();
  const visitedDirectories = new Set<string>();
  const unsupported: string[] = [];
  let hasDirectory = false;

  function collectDirectory(directory: string): void {
    const canonicalDirectory = canonical(directory);
    if (isExternal(directory) || isExternal(canonicalDirectory) || visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    for (const name of readdirSync(canonicalDirectory)) {
      const path = join(canonicalDirectory, name);
      if (isExternal(path)) continue;
      const stat = statSync(path);
      if (stat.isDirectory()) collectDirectory(path);
      else if (stat.isFile() && typescriptFile.test(path)) {
        const file = canonical(path);
        if (!isExternal(file)) roots.add(file);
      }
    }
  }

  for (const entry of entries) {
    const path = resolve(cwd, entry);
    if (!ts.sys.fileExists(path) && !ts.sys.directoryExists(path)) {
      throw new Error(`Not an existing TypeScript file or directory: ${entry}`);
    }
    const file = canonical(path);
    if (isExternal(file)) {
      throw new Error(`Entries must be outside node_modules: ${entry}`);
    }
    if (ts.sys.directoryExists(path)) {
      hasDirectory = true;
      collectDirectory(path);
    } else if (typescriptFile.test(path)) {
      roots.add(file);
    } else {
      unsupported.push(entry);
    }
  }
  if (!roots.size) {
    if (hasDirectory) return [];
    throw new Error(`Not an existing TypeScript file: ${unsupported[0]}`);
  }
  const configs = new Map<string, ts.CompilerOptions>();
  const contexts = new Map<string, {
    options: ts.CompilerOptions;
    cache: ts.ModuleResolutionCache;
  }>();

  function contextFor(file: string) {
    const directory = dirname(file);
    const existing = contexts.get(directory);
    if (existing) return existing;

    const configPath = ts.findConfigFile(directory, ts.sys.fileExists);
    let options = configPath ? configs.get(configPath) : undefined;
    if (!options) {
      if (configPath) {
        const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
            throw new Error(formatDiagnostics([diagnostic]));
          },
        });
        if (!parsed) throw new Error(`Could not read ${configPath}`);
        // Explicit entry files can be outside the config's include patterns.
        const errors = parsed.errors.filter((error) => error.code !== 18002 && error.code !== 18003);
        if (errors.length) throw new Error(formatDiagnostics(errors));
        options = parsed.options;
        configs.set(configPath, options);
      } else {
        options = {
          target: ts.ScriptTarget.Latest,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.Preserve,
          allowJs: true,
        };
      }
    }
    const context = {
      options,
      cache: ts.createModuleResolutionCache(directory, (path) =>
        ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase(), options),
    };
    contexts.set(directory, context);
    return context;
  }

  const sources = new Map<string, ts.SourceFile>();
  const isLocalScript = (file: string) => scriptExtension.test(extname(file)) && !isExternal(file);

  function resolveModule(specifier: ts.StringLiteralLike, source: ts.SourceFile) {
    const { options, cache } = contextFor(source.fileName);
    const mode = ts.getModeForUsageLocation(source, specifier, options);
    return ts.resolveModuleName(specifier.text, source.fileName, options, ts.sys, cache, undefined, mode);
  }

  function moduleTarget(specifier: ts.StringLiteralLike, source: ts.SourceFile, required = true): string | undefined {
    if (builtins.has(specifier.text)) return;
    const resolved = resolveModule(specifier, source).resolvedModule;
    if (resolved) {
      const file = canonical(resolved.resolvedFileName);
      return isLocalScript(file) ? file : undefined;
    }
    const extension = extname(specifier.text);
    if (!required || (extension && !scriptExtension.test(extension))) return;
    throw new Error(`Cannot resolve "${specifier.text}" imported by ${relative(cwd, source.fileName)}. Check the project's dependencies and tsconfig.json.`);
  }

  function specifierOf(node: ts.Node): ts.StringLiteralLike | undefined {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      return node.moduleSpecifier;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      return node.moduleReference.expression;
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)) {
      return node.argument.literal;
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) return argument;
    }
  }

  function referencesOf(source: ts.SourceFile, required: boolean): string[] {
    const files: string[] = [];
    for (const reference of source.referencedFiles) {
      const target = canonical(resolve(dirname(source.fileName), reference.fileName));
      if (ts.sys.fileExists(target)) files.push(target);
      else if (required) {
        throw new Error(`Cannot resolve reference "${reference.fileName}" in ${relative(cwd, source.fileName)}`);
      }
    }
    for (const reference of source.typeReferenceDirectives) {
      const { options } = contextFor(source.fileName);
      const target = ts.resolveTypeReferenceDirective(reference.fileName, source.fileName, options, ts.sys)
        .resolvedTypeReferenceDirective?.resolvedFileName;
      if (target) files.push(canonical(target));
      else if (required) {
        throw new Error(`Cannot resolve type reference "${reference.fileName}" in ${relative(cwd, source.fileName)}`);
      }
    }
    return files.filter(isLocalScript);
  }

  // Bind the local graph so aliases, shadowed names, and export-star chains can
  // be resolved by TypeScript. Discovery does not add files to the output.
  const discovery = [...roots];
  while (discovery.length) {
    const file = discovery.pop()!;
    if (sources.has(file)) continue;
    const text = ts.sys.readFile(file);
    if (text === undefined) throw new Error(`Cannot read dependency: ${file}`);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    source.impliedNodeFormat = ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, contextFor(file).options);
    sources.set(file, source);
    const discover = (node: ts.Node): void => {
      const specifier = specifierOf(node);
      const target = specifier && moduleTarget(specifier, source, false);
      if (target) discovery.push(target);
      ts.forEachChild(node, discover);
    };
    discover(source);
    discovery.push(...referencesOf(source, false));
  }

  const compilerOptions: ts.CompilerOptions = {
    ...contextFor([...roots][0]!).options,
    noLib: true,
    types: [],
    allowJs: true,
    noResolve: false,
    noEmit: true,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  const getSourceFile = host.getSourceFile;
  host.getCurrentDirectory = () => cwd;
  host.getSourceFile = (file, ...args) => sources.get(canonical(file)) ?? getSourceFile(file, ...args);
  host.resolveModuleNameLiterals = (literals, file, redirected, options, source) => literals.map((literal) => {
    const result = sources.has(canonical(file))
      ? resolveModule(literal, source)
      : ts.resolveModuleName(literal.text, file, options, ts.sys, undefined, redirected,
        ts.getModeForUsageLocation(source, literal, options));
    const resolved = result.resolvedModule;
    const target = resolved && canonical(resolved.resolvedFileName);
    return {
      ...result,
      resolvedModule: resolved && target
        ? { ...resolved, resolvedFileName: target }
        : undefined,
    };
  });
  const program = ts.createProgram([...sources.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();
  const exports = new Map<ts.SourceFile, Map<string, ts.Symbol>>();
  function exportsOf(source: ts.SourceFile): Map<string, ts.Symbol> {
    let result = exports.get(source);
    if (!result) {
      const symbol = checker.getSymbolAtLocation(source);
      result = new Map(symbol ? checker.getExportsOfModule(symbol).map((item) => [item.name, item]) : []);
      exports.set(source, result);
    }
    return result;
  }

  const dependencies = new Set<string>();
  const initialized = new Set<string>();
  const visitedNodes = new Set<ts.Node>();
  const processedExports = new Map<string, Set<string>>();
  const processedAll = new Set<string>();
  const pending: { file: string; names?: readonly string[] }[] = [];

  function request(file: string, names?: readonly string[]): void {
    pending.push({ file, names });
  }

  function followModule(specifier: ts.StringLiteralLike, names?: readonly string[]): void {
    const target = moduleTarget(specifier, specifier.getSourceFile());
    if (target) request(target, names);
  }

  function isSideEffectImport(node: ts.Node): node is ts.ImportDeclaration {
    if (!ts.isImportDeclaration(node)) return false;
    const clause = node.importClause;
    return !clause || (!clause.isTypeOnly && !clause.name && !!clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length === 0);
  }

  function memberNames(usage: ts.Node): string[] | undefined {
    let node = usage;
    while (ts.isParenthesizedExpression(node.parent) || ts.isAwaitExpression(node.parent)) node = node.parent;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return [parent.name.text];
    if (ts.isQualifiedName(parent) && parent.left === node) return [parent.right.text];
    if (ts.isElementAccessExpression(parent) && parent.expression === node &&
        parent.argumentExpression && ts.isStringLiteralLike(parent.argumentExpression)) {
      return [parent.argumentExpression.text];
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
      const names: string[] = [];
      for (const element of parent.name.elements) {
        if (element.dotDotDotToken) return;
        const name = element.propertyName ?? element.name;
        if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return;
        names.push(name.text);
      }
      return names;
    }
  }

  function followSymbol(symbol: ts.Symbol, usage?: ts.Node): void {
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(declaration)) {
        const specifier = specifierOf(declaration.parent.parent.parent);
        if (specifier) followModule(specifier, [(declaration.propertyName ?? declaration.name).text]);
      } else if (ts.isImportClause(declaration)) {
        const specifier = specifierOf(declaration.parent);
        if (specifier) followModule(specifier, ["default"]);
      } else if (ts.isNamespaceImport(declaration) || ts.isImportEqualsDeclaration(declaration)) {
        const specifier = specifierOf(ts.isNamespaceImport(declaration) ? declaration.parent.parent : declaration);
        if (specifier) followModule(specifier, usage ? memberNames(usage) : undefined);
      } else {
        visit(declaration);
      }
    }
  }

  function visit(node: ts.Node): void {
    if (visitedNodes.has(node)) return;
    visitedNodes.add(node);
    if (ts.isImportDeclaration(node)) {
      if (isSideEffectImport(node) && ts.isStringLiteralLike(node.moduleSpecifier)) followModule(node.moduleSpecifier);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) return;
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const names = node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text)
          : undefined;
        followModule(node.moduleSpecifier, names);
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) visit(element);
      }
      return;
    }
    if (ts.isExportSpecifier(node)) {
      const declaration = node.parent.parent;
      if (declaration.moduleSpecifier && ts.isStringLiteralLike(declaration.moduleSpecifier)) {
        followModule(declaration.moduleSpecifier, [(node.propertyName ?? node.name).text]);
      } else {
        const symbol = checker.getExportSpecifierLocalTargetSymbol(node);
        if (symbol) followSymbol(symbol);
      }
      return;
    }
    if (ts.isNamespaceExport(node)) {
      const specifier = specifierOf(node.parent);
      if (specifier) followModule(specifier);
      return;
    }
    const specifier = specifierOf(node);
    if (specifier) {
      let names: string[] | undefined;
      if (ts.isImportTypeNode(node) && node.qualifier) {
        let qualifier = node.qualifier;
        while (ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
        names = [qualifier.text];
      } else if (ts.isCallExpression(node)) {
        // A dynamic import returns a promise; `.then` is not a module export.
        if (node.expression.kind !== ts.SyntaxKind.ImportKeyword || ts.isAwaitExpression(node.parent)) {
          names = memberNames(node);
        }
      }
      followModule(specifier, names);
    }
    if (ts.isIdentifier(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      if (symbol?.declarations?.some((declaration) => declaration.getSourceFile() === node.getSourceFile())) {
        followSymbol(symbol, node);
      }
    }
    ts.forEachChild(node, visit);
  }

  function followExport(source: ts.SourceFile, name: string): void {
    const commonJS = checker.getSymbolAtLocation(source)?.exports?.get(ts.InternalSymbolName.ExportEquals);
    if (commonJS) {
      followSymbol(commonJS);
      return;
    }
    const symbol = exportsOf(source).get(name);
    if (!symbol) {
      throw new Error(`Cannot find export "${name}" in ${relative(cwd, source.fileName)}`);
    }
    const localDeclarations = symbol.declarations?.filter((declaration) => declaration.getSourceFile() === source) ?? [];
    if (localDeclarations.length) {
      for (const declaration of localDeclarations) visit(declaration);
      return;
    }
    const targetSymbol = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.exportClause || name === "default") continue;
      const specifier = specifierOf(statement);
      const target = specifier && moduleTarget(specifier, source, false);
      const targetSource = target && sources.get(target);
      const candidate = targetSource && exportsOf(targetSource).get(name);
      if (candidate && (candidate.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(candidate) : candidate) === targetSymbol) {
        request(target!, [name]);
      }
    }
  }

  for (const file of roots) request(file);
  while (pending.length) {
    const { file, names } = pending.pop()!;
    if (processedAll.has(file)) continue;
    const source = sources.get(file)!;
    if (!roots.has(file) && typescriptFile.test(file)) dependencies.add(file);
    if (!initialized.has(file)) {
      initialized.add(file);
      for (const statement of source.statements) {
        if (isSideEffectImport(statement) || ts.isExpressionStatement(statement)) {
          visit(statement);
        }
      }
      for (const reference of referencesOf(source, true)) request(reference);
    }
    if (names === undefined) {
      processedAll.add(file);
      visit(source);
    } else {
      let processed = processedExports.get(file);
      if (!processed) processedExports.set(file, processed = new Set());
      for (const name of names) {
        if (processed.has(name)) continue;
        processed.add(name);
        followExport(source, name);
      }
    }
  }

  return [...dependencies].map((file) => {
    const path = relative(cwd, file);
    return (isAbsolute(path) ? file : path).split(sep).join("/");
  }).sort();
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
  } else {
    try {
      const files = collectDependencies(args);
      if (files.length) console.log(files.join("\n"));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}