import { descendants, parseGo, sourceText } from "./parser.js";
import { type Signal, type SourceRevision } from "./types.js";
import { type Node } from "web-tree-sitter";

const RULE_ID = "go-perf.request-keyed-cache-amplification";

interface Parameter {
  name: string;
  type: string;
  httpRequest: boolean;
  sqlDatabase: boolean;
}

interface Assignment {
  targets: string[];
  expressions: string[];
  line: number;
  start: number;
  end: number;
  visibilityEnd: number;
  scopeId: string;
  declaration: boolean;
  terminatesBranch: boolean;
  branchGroup?: string;
  branchArm?: "then" | "else";
  branchExhaustive?: boolean;
}

interface Call {
  name: string;
  functionText: string;
  args: string[];
  line: number;
  endLine: number;
  text: string;
  start: number;
  scopeId: string;
  executable: boolean;
  hitEscape: boolean;
  missBranch?: { start: number; end: number };
}

interface CacheAccess {
  cacheId?: string;
  cacheText: string;
  key: string;
  line: number;
  endLine: number;
  text: string;
  value: string;
  kind: "lookup" | "insert";
  start: number;
  end: number;
  scopeId: string;
  hitEscape: boolean;
  missBranch?: { start: number; end: number };
}

interface LexicalScope {
  id: string;
  parent?: string;
  start: number;
  end: number;
  parameters: Parameter[];
  functionBoundary: boolean;
  conditional: boolean;
  invocationArguments?: string[];
}

interface ReturnFact {
  expressions: string[];
  start: number;
  scopeId: string;
}

interface RequestSource {
  line: number;
  endLine: number;
  origin: string;
}

interface AdmissionFact {
  key: string;
  start: number;
  scopeId: string;
}

interface CapacityGuardFact {
  cache: string;
  bound: string;
  start: number;
  end: number;
  scopeId: string;
  kind: "return" | "ranged-eviction";
  boundLocallyShadowed: boolean;
}

interface FunctionFact {
  id: string;
  name: string;
  path: string;
  file: SourceRevision;
  start: number;
  startLine: number;
  source: string;
  params: Parameter[];
  assignments: Assignment[];
  calls: Call[];
  returns: ReturnFact[];
  accesses: CacheAccess[];
  requestSources: RequestSource[];
  admissions: AdmissionFact[];
  capacityGuards: CapacityGuardFact[];
  httpAliases: Set<string>;
  fileAliases: Set<string>;
  scope: string;
  scopes: Map<string, LexicalScope>;
  rootScopeId: string;
  receiverCaches: Map<string, string>;
  receiverName?: string;
  receiverType?: string;
}

interface PersistentCache {
  id: string;
  path: string;
  line: number;
  endLine: number;
  text: string;
}

interface ProgramFacts {
  functions: FunctionFact[];
  caches: Map<string, PersistentCache>;
  finiteConstants: Set<string>;
  shadowedBuiltins: Set<string>;
}

type Dependencies = Set<string>;
interface CallEdge {
  caller: FunctionFact;
  callee: FunctionFact;
  line: number;
  endLine: number;
  start: number;
  scopeId: string;
  call: Call;
}

export async function requestKeyedCacheSignals(files: SourceRevision[]): Promise<Signal[]> {
  const previousFiles = files.flatMap((file): SourceRevision[] => {
    if (file.status === "added") return [];
    const { previous, ...revision } = file;
    if (file.status === "modified") {
      if (previous === undefined) return [];
      return [{ ...revision, current: previous, status: "repository", changedLines: new Set() }];
    }
    return [{ ...revision, status: "repository", changedLines: new Set() }];
  });
  const previousFingerprints = files.some((file) => file.status === "modified" && file.previous !== undefined)
    ? new Set((await currentRequestKeyedCacheSignals(previousFiles)).map((signal) => signal.data.semanticFingerprint as string))
    : new Set<string>();
  return (await currentRequestKeyedCacheSignals(files)).filter((signal) =>
    !previousFingerprints.has(signal.data.semanticFingerprint as string));
}

async function currentRequestKeyedCacheSignals(files: SourceRevision[]): Promise<Signal[]> {
  const program = await collectProgramFacts(files.filter((file) => file.path.endsWith(".go")));
  if (program.caches.size === 0 || program.functions.length === 0) return [];

  const byName = uniqueFunctionsByName(program.functions);
  const returnDependencies = calculateReturnDependencies(program.functions, byName);
  const parameterSeeds = calculateRequestParameterSeeds(program.functions, byName, returnDependencies);
  const callEdges = requestCallEdges(program.functions, byName, returnDependencies, parameterSeeds);
  const lookupSummaries = cacheLookupSummaries(program.functions, byName, returnDependencies, program.caches);
  const signals: Signal[] = [];

  for (const fn of program.functions) {
    const seeds = parameterSeeds.get(fn.id) ?? new Map();
    for (const insertion of fn.accesses.filter((access) => access.kind === "insert")) {
      const insertionCacheId = resolveCacheAt(fn, insertion.cacheText, insertion.start, insertion.scopeId, program.caches);
      if (insertionCacheId === undefined) continue;
      insertion.cacheId = insertionCacheId;
      const cache = program.caches.get(insertionCacheId);
      if (cache === undefined) continue;
      const insertionEnvironment = environmentAt(fn, insertion.start, insertion.scopeId, seeds, byName, returnDependencies);
      const keyDependencies = expressionDependencies(insertion.key, insertionEnvironment, byName, returnDependencies);
      if (requestOrigins(keyDependencies).size === 0) continue;

      const lookup = findCacheLookup(
        fn, insertion, keyDependencies, seeds, lookupSummaries, byName, returnDependencies, program.caches,
      );
      if (lookup === undefined) continue;
      const material = findMaterialWork(fn, insertion, lookup, keyDependencies, seeds, byName, returnDependencies);
      if (material === undefined) continue;

      const requestPath = requestPathTo(fn, callEdges);
      if (receiverCacheIsProvenRequestLocal(fn, insertion.cacheId, requestPath)) continue;
      const localAdmission = hasFiniteAdmission([{
        fn,
        beforePosition: material.start,
        seeds,
      }], keyDependencies, byName, returnDependencies);
      const incoming = requestPath.filter((edge) => edge.callee.id === fn.id);
      const allIncomingAdmitted = incoming.length > 0 && incoming.every((edge) => {
        const callerSeeds = parameterSeeds.get(edge.caller.id) ?? new Map();
        const callerEnvironment = environmentAt(
          edge.caller, edge.start, edge.scopeId, callerSeeds, byName, returnDependencies,
        );
        const mappedKey = mapParameterDependencies(keyDependencies, edge.call, callerEnvironment, byName, returnDependencies);
        return hasFiniteAdmission([{
          fn: edge.caller,
          beforePosition: edge.start,
          seeds: callerSeeds,
        }], mappedKey, byName, returnDependencies);
      });
      if (localAdmission || allIncomingAdmitted) {
        continue;
      }
      if (hasHardCacheBound(
        fn,
        insertion,
        material,
        program.finiteConstants,
        program.shadowedBuiltins,
        program.caches,
        program.functions,
      )) continue;

      const anchors = [
        { path: cache.path, line: cache.line, endLine: cache.endLine, role: "persistent cache declaration" },
        ...requestPath.map((edge) => ({
          path: edge.caller.path,
          line: edge.line,
          endLine: edge.endLine,
          role: "request-key propagation",
        })),
        ...[fn, ...requestPath.map((edge) => edge.caller)].flatMap((item) =>
          item.requestSources.filter((source) => keyDependencies.has(source.origin)).map((source) => ({
            path: item.path,
            line: source.line,
            endLine: source.endLine,
            role: "request-key source",
          }))),
        { path: fn.path, line: lookup.line, endLine: lookup.endLine, role: "cache lookup" },
        { path: fn.path, line: material.line, endLine: material.endLine, role: "material miss work" },
        { path: fn.path, line: insertion.line, endLine: insertion.endLine, role: "cache insertion" },
      ];
      const anchor = anchors.map((candidate) => ({
        ...candidate,
        changedLine: changedLineInRange(files, candidate.path, candidate.line, candidate.endLine),
      })).find((candidate) => candidate.changedLine !== undefined);
      if (anchor === undefined) continue;
      const changedLine = anchor.changedLine!;
      const anchorFile = files.find((candidate) => candidate.path === anchor.path);

      const scanUnderLock = hasSharedLinearScan(program.functions, insertion.cacheId);
      const semanticFingerprint = [
        cache.id,
        `${fn.path}:${fn.name}`,
        semanticCode(cache.text),
        semanticCode(lookup.text),
        semanticCode(material.text),
        semanticCode(insertion.text),
        [...keyDependencies].sort().join(","),
        ...requestPath.map((edge) => `${edge.caller.path}:${edge.caller.name}:${semanticCode(edge.call.text)}`),
      ].join("|");
      signals.push({
        ruleId: RULE_ID,
        path: anchor.path,
        line: changedLine,
        message:
          `A request-controlled key reaches ${insertion.cacheText}, whose miss path performs ${material.name} ` +
          `before inserting into a long-lived cache without a proven entry/weight bound or eviction.` +
          (scanUnderLock ? " The same cache is also scanned under a lock, multiplying per-request work as it grows." : ""),
        snippet: lineAt(anchorFile?.current ?? "", changedLine).trim().slice(0, 300),
        data: {
          anchor: anchor.role,
          cache: insertion.cacheText,
          cacheDeclaration: `${cache.path}:${cache.line}`,
          lookup: `${fn.path}:${lookup.line}`,
          materialWork: `${fn.path}:${material.line}`,
          insertion: `${fn.path}:${insertion.line}`,
          requestPath: requestPath.map((edge) => `${edge.caller.path}:${edge.line} -> ${edge.callee.name}`),
          ttlIsNotCardinalityBound: true,
          sharedLinearScanUnderLock: scanUnderLock,
          semanticFingerprint,
        },
      });
    }
  }

  return deduplicate(signals);
}

function semanticCode(source: string): string {
  return maskGoNonCode(source, false).replace(/\s+/g, "");
}

async function collectProgramFacts(files: SourceRevision[]): Promise<ProgramFacts> {
  const functions: FunctionFact[] = [];
  const caches = new Map<string, PersistentCache>();
  const finiteConstants = new Set<string>();
  const shadowedBuiltins = new Set<string>();
  const receiverMapFields = new Map<string, Set<string>>();

  for (const file of files) {
    const tree = await parseGo(file.current);
    try {
      if (tree.rootNode.hasError) continue;
      const scope = packageScope(file.path);
      for (const declaration of descendants(tree.rootNode, "function_declaration")) {
        if (declaration.parent?.type !== "source_file") continue;
        const name = declaration.childForFieldName("name");
        if (name !== null && sourceText(name, file.current) === "len") shadowedBuiltins.add(`${scope}:len`);
      }
      for (const declaration of descendants(tree.rootNode, "var_spec")
        .concat(descendants(tree.rootNode, "const_spec"))
        .concat(descendants(tree.rootNode, "type_spec"))) {
        if (declaration.parent?.parent?.type !== "source_file" && declaration.parent?.type !== "source_file") continue;
        if (declaredNames(declaration, file.current).includes("len")) shadowedBuiltins.add(`${scope}:len`);
      }
      collectFiniteConstants(file, tree.rootNode, finiteConstants, scope);
      collectPersistentCaches(file, tree.rootNode, caches, receiverMapFields, scope);
      const aliases = importAliases(file.current, tree.rootNode, "net/http", "http");
      const sqlAliases = importAliases(file.current, tree.rootNode, "database/sql", "sql");
      const fileAliases = new Set([
        ...importAliases(file.current, tree.rootNode, "os", "os"),
        ...importAliases(file.current, tree.rootNode, "io/fs", "fs"),
      ]);
      for (const node of [
        ...descendants(tree.rootNode, "function_declaration"),
        ...descendants(tree.rootNode, "method_declaration"),
      ]) {
        const fact = functionFact(file, node, caches, receiverMapFields, aliases, sqlAliases, fileAliases, scope);
        if (fact !== undefined) functions.push(fact);
      }
    } finally {
      tree.delete();
    }
  }
  return { functions, caches, finiteConstants, shadowedBuiltins };
}

function collectPersistentCaches(
  file: SourceRevision,
  root: Node,
  caches: Map<string, PersistentCache>,
  receiverMapFields: Map<string, Set<string>>,
  scope: string,
): void {
  for (const declaration of descendants(root, "var_declaration")) {
    if (declaration.parent?.type !== "source_file") continue;
    for (const spec of descendants(declaration, "var_spec")) {
      const text = sourceText(spec, file.current);
      if (!/\bmap\s*\[/.test(text)) continue;
      const name = text.match(/^\s*([A-Za-z_]\w*)/)?.[1];
      if (name === undefined) continue;
      caches.set(`global:${scope}:${name}`, {
        id: `global:${scope}:${name}`,
        path: file.path,
        line: spec.startPosition.row + 1,
        endLine: spec.endPosition.row + 1,
        text: text.trim(),
      });
    }
  }

  for (const typeSpec of descendants(root, "type_spec")) {
    const typeNameNode = typeSpec.childForFieldName("name");
    const type = typeSpec.childForFieldName("type");
    if (typeNameNode === null || type?.type !== "struct_type") continue;
    const typeName = sourceText(typeNameNode, file.current);
    for (const field of descendants(type, "field_declaration")) {
      const fieldType = field.childForFieldName("type");
      if (fieldType === null || !/^map\s*\[/.test(sourceText(fieldType, file.current).trim())) continue;
      const name = field.childForFieldName("name");
      if (name === null) continue;
      const fieldName = sourceText(name, file.current);
      const receiverType = `${scope}:${typeName}`;
      const fields = receiverMapFields.get(receiverType) ?? new Set<string>();
      fields.add(fieldName);
      receiverMapFields.set(receiverType, fields);
      caches.set(`field:${receiverType}.${fieldName}`, {
        id: `field:${receiverType}.${fieldName}`,
        path: file.path,
        line: field.startPosition.row + 1,
        endLine: field.endPosition.row + 1,
        text: sourceText(field, file.current).trim(),
      });
    }
  }
}

function functionFact(
  file: SourceRevision,
  node: Node,
  caches: Map<string, PersistentCache>,
  receiverMapFields: Map<string, Set<string>>,
  httpAliases: Set<string>,
  sqlAliases: Set<string>,
  fileAliases: Set<string>,
  scope: string,
): FunctionFact | undefined {
  const nameNode = node.childForFieldName("name");
  const parametersNode = node.childForFieldName("parameters");
  const body = node.childForFieldName("body");
  if (nameNode === null || parametersNode === null || body === null) return undefined;
  const name = sourceText(nameNode, file.current);
  const params = parameters(parametersNode, file.current, httpAliases, sqlAliases);
  const scopes = lexicalScopes(body, file.current, params, httpAliases, sqlAliases);
  const rootScopeId = scopeForNode(body, scopes).id;

  const assignments = descendants(body, "short_var_declaration")
    .concat(descendants(body, "assignment_statement"))
    .sort((left, right) => left.startIndex - right.startIndex)
    .map((assignment) => assignmentFact(file.current, assignment, scopeForNode(assignment, scopes).id))
    .filter((item): item is Assignment => item !== undefined)
    .concat(descendants(body, "var_spec")
      .sort((left, right) => left.startIndex - right.startIndex)
      .map((spec) => variableFact(file.current, spec, scopeForNode(spec, scopes).id))
      .filter((item): item is Assignment => item !== undefined))
    .sort((left, right) => left.start - right.start);
  const calls = descendants(body, "call_expression")
    .sort((left, right) => left.startIndex - right.startIndex)
    .map((call) => callFact(file.current, call, scopeForNode(call, scopes).id))
    .filter((item): item is Call => item !== undefined && item.executable);
  const returns = descendants(body, "return_statement").map((item) => {
    const text = sourceText(item, file.current).replace(/^\s*return\b/, "").trim();
    return {
      expressions: splitTopLevel(text),
      start: item.startIndex,
      scopeId: scopeForNode(item, scopes).id,
    };
  });
  const receiverCaches = new Map<string, string>();
  let receiverVariable: string | undefined;
  let receiverTypeName: string | undefined;
  const receiver = node.childForFieldName("receiver");
  if (receiver !== null) {
    const declaration = descendants(receiver, "parameter_declaration")[0];
    const receiverName = declaration?.childForFieldName("name");
    const receiverType = declaration?.childForFieldName("type");
    if (receiverName !== null && receiverName !== undefined && receiverType !== null && receiverType !== undefined) {
      const variable = sourceText(receiverName, file.current);
      const typeName = sourceText(receiverType, file.current).replace(/^\*/, "");
      receiverVariable = variable;
      receiverTypeName = typeName;
      const receiverId = `${scope}:${typeName}`;
      for (const field of receiverMapFields.get(receiverId) ?? []) {
        receiverCaches.set(`${variable}.${field}`, `field:${receiverId}.${field}`);
      }
    }
  }
  const accesses = cacheAccesses(file.current, body, scopes);
  const admissions = fixedAdmissions(file.current, body, scopes);
  const capacityGuards = capacityGuardFacts(file.current, body, scopes);
  const requestSources = calls
    .filter((call) => {
      const receiver = call.functionText.match(/^([A-Za-z_]\w*)\./)?.[1];
      return receiver !== undefined && requestReceiverAt(receiver, call.scopeId, scopes) &&
        /(?:\.Cookie|\.PathValue|\.Header\.Get|\.URL\.Query\(\)\.Get)$/.test(call.functionText);
    })
    .map((call) => ({
      line: call.line,
      endLine: call.endLine,
      origin: `origin:${call.text.replace(/\s+/g, "")}`,
    }));
  for (const index of descendants(body, "index_expression")) {
    const text = sourceText(index, file.current).replace(/\s+/g, "");
    const receiver = text.match(/^([A-Za-z_]\w*)\./)?.[1];
    if (receiver !== undefined && requestReceiverAt(receiver, scopeForNode(index, scopes).id, scopes) &&
      (text.startsWith(`${receiver}.Header[`) || text.startsWith(`${receiver}.URL.Query()[`))) {
      requestSources.push({
        line: index.startPosition.row + 1,
        endLine: index.endPosition.row + 1,
        origin: `origin:${text}`,
      });
    }
  }
  for (const selector of descendants(body, "selector_expression")) {
    const text = sourceText(selector, file.current);
    const receiver = text.match(/^([A-Za-z_]\w*)\./)?.[1];
    if (receiver !== undefined && requestReceiverAt(receiver, scopeForNode(selector, scopes).id, scopes) &&
      /\.URL\.(?:Path|RawPath)$/.test(text)) {
      requestSources.push({
        line: selector.startPosition.row + 1,
        endLine: selector.endPosition.row + 1,
        origin: `origin:${text.replace(/\s+/g, "")}`,
      });
    }
  }

  return {
    id: `${file.path}:${node.startPosition.row + 1}:${name}`,
    name,
    path: file.path,
    file,
    start: node.startIndex,
    startLine: node.startPosition.row + 1,
    source: sourceText(node, file.current),
    params,
    assignments,
    calls,
    returns,
    accesses,
    requestSources: [...new Map(requestSources.map((source) =>
      [`${source.line}:${source.endLine}:${source.origin}`, source])).values()],
    admissions,
    capacityGuards,
    httpAliases,
    fileAliases,
    scope,
    scopes,
    rootScopeId,
    receiverCaches,
    ...(receiverVariable === undefined ? {} : { receiverName: receiverVariable }),
    ...(receiverTypeName === undefined ? {} : { receiverType: receiverTypeName }),
  };
}

function parameters(
  node: Node,
  source: string,
  httpAliases: Set<string>,
  sqlAliases: Set<string>,
): Parameter[] {
  const result: Parameter[] = [];
  for (const declaration of descendants(node, "parameter_declaration")) {
    const typeNode = declaration.childForFieldName("type");
    if (typeNode === null) continue;
    const type = sourceText(typeNode, source);
    for (const name of declaration.namedChildren.filter((child) =>
      child.type === "identifier" && child.endIndex <= typeNode.startIndex)) {
      result.push({
        name: sourceText(name, source),
        type,
        httpRequest: isHttpRequestType(type, httpAliases),
        sqlDatabase: isSqlDatabaseType(type, sqlAliases),
      });
    }
  }
  return result;
}

function lexicalScopes(
  body: Node,
  source: string,
  rootParameters: Parameter[],
  httpAliases: Set<string>,
  sqlAliases: Set<string>,
): Map<string, LexicalScope> {
  const blocks = descendants(body, "block").sort((left, right) => left.startIndex - right.startIndex);
  const result = new Map<string, LexicalScope>();
  for (const block of blocks) {
    const id = `block:${block.startIndex}`;
    let parentNode = block.parent;
    while (parentNode !== null && parentNode.type !== "block") parentNode = parentNode.parent;
    const parent = parentNode === null || !blocks.some((candidate) => candidate.id === parentNode!.id)
      ? undefined
      : `block:${parentNode.startIndex}`;
    let scopeParameters: Parameter[] = [];
    if (block.id === body.id) {
      scopeParameters = rootParameters;
    } else if (block.parent?.type === "func_literal") {
      const parameterList = block.parent.childForFieldName("parameters");
      if (parameterList !== null) scopeParameters = parameters(parameterList, source, httpAliases, sqlAliases);
    } else if (block.parent?.type === "for_statement") {
      const range = block.parent.namedChildren.find((child) => child.type === "range_clause");
      if (range !== undefined && sourceText(range, source).includes(":=")) {
        const names = range.namedChildren.find((child) => child.type === "expression_list")?.namedChildren ?? [];
        scopeParameters = names.filter((name) => name.type === "identifier").map((name) => ({
          name: sourceText(name, source),
          type: "",
          httpRequest: false,
          sqlDatabase: false,
        }));
      }
    }
    const literal = block.parent?.type === "func_literal" ? block.parent : undefined;
    const invocation = literal?.parent?.type === "call_expression" &&
      literal.parent.childForFieldName("function")?.id === literal.id ? literal.parent : undefined;
    const invocationArguments = invocation?.childForFieldName("arguments")?.namedChildren.map((argument) =>
      sourceText(argument, source));
    result.set(id, {
      id,
      ...(parent === undefined ? {} : { parent }),
      start: block.startIndex,
      end: block.endIndex,
      parameters: scopeParameters,
      functionBoundary: block.id === body.id || block.parent?.type === "func_literal",
      conditional: block.parent !== null && [
        "if_statement",
        "for_statement",
        "select_statement",
      ].includes(block.parent.type),
      ...(invocationArguments === undefined ? {} : { invocationArguments }),
    });
  }
  for (const communication of descendants(body, "communication_case")) {
    const receive = communication.namedChildren.find((child) => child.type === "receive_statement");
    if (receive === undefined || !sourceText(receive, source).includes(":=")) continue;
    const names = receive.namedChildren.find((child) => child.type === "expression_list")?.namedChildren ?? [];
    let parentNode = communication.parent;
    while (parentNode !== null && parentNode.type !== "block") parentNode = parentNode.parent;
    const parent = parentNode === null ? undefined : `block:${parentNode.startIndex}`;
    const id = `case:${communication.startIndex}`;
    result.set(id, {
      id,
      ...(parent === undefined ? {} : { parent }),
      start: communication.startIndex,
      end: communication.endIndex,
      parameters: names.filter((name) => name.type === "identifier").map((name) => ({
        name: sourceText(name, source),
        type: "",
        httpRequest: false,
        sqlDatabase: false,
      })),
      functionBoundary: false,
      conditional: true,
    });
  }
  for (const statement of descendants(body, "type_switch_statement")) {
    const names = statement.namedChildren.find((child) => child.type === "expression_list")?.namedChildren ?? [];
    const aliases = names.filter((name) => name.type === "identifier").map((name) => ({
      name: sourceText(name, source),
      type: "",
      httpRequest: false,
      sqlDatabase: false,
    }));
    if (aliases.length === 0 || !sourceText(statement, source).includes(":=")) continue;
    let parentNode = statement.parent;
    while (parentNode !== null && parentNode.type !== "block") parentNode = parentNode.parent;
    const parent = parentNode === null ? undefined : `block:${parentNode.startIndex}`;
    for (const item of statement.namedChildren.filter((child) =>
      child.type === "type_case" || child.type === "default_case")) {
      const id = `case:${item.startIndex}`;
      result.set(id, {
        id,
        ...(parent === undefined ? {} : { parent }),
        start: item.startIndex,
        end: item.endIndex,
        parameters: aliases,
        functionBoundary: false,
        conditional: true,
      });
    }
  }
  if (result.size === 0) {
    const id = `block:${body.startIndex}`;
    result.set(id, {
      id,
      start: body.startIndex,
      end: body.endIndex,
      parameters: rootParameters,
      functionBoundary: true,
      conditional: false,
    });
  }
  return result;
}

function scopeForNode(node: Node, scopes: Map<string, LexicalScope>): LexicalScope {
  const candidates = [...scopes.values()].filter((scope) =>
    node.startIndex >= scope.start && node.endIndex <= scope.end);
  return candidates.sort((left, right) => (left.end - left.start) - (right.end - right.start))[0] ??
    [...scopes.values()][0]!;
}

function scopeAncestors(scopes: Map<string, LexicalScope>, scopeId: string): string[] {
  const result: string[] = [];
  let current: string | undefined = scopeId;
  while (current !== undefined) {
    result.unshift(current);
    current = scopes.get(current)?.parent;
  }
  return result;
}

function callableScope(scopes: Map<string, LexicalScope>, scopeId: string): string {
  return scopeAncestors(scopes, scopeId).reverse()
    .find((candidate) => scopes.get(candidate)?.functionBoundary) ?? scopeId;
}

function conditionallyExecutedRelativeTo(
  scopes: Map<string, LexicalScope>,
  scopeId: string,
  ancestorScopeId: string,
): boolean {
  let current: string | undefined = scopeId;
  while (current !== undefined && current !== ancestorScopeId) {
    const scope = scopes.get(current);
    if (scope?.conditional) return true;
    current = scope?.parent;
  }
  return false;
}

function requestReceiverAt(receiver: string, scopeId: string, scopes: Map<string, LexicalScope>): boolean {
  const ancestors = scopeAncestors(scopes, scopeId).reverse();
  for (const ancestor of ancestors) {
    const parameter = scopes.get(ancestor)?.parameters.find((candidate) => candidate.name === receiver);
    if (parameter !== undefined) return parameter.httpRequest;
  }
  return false;
}

function assignmentFact(source: string, node: Node, scopeId: string): Assignment | undefined {
  const text = sourceText(node, source);
  const operator = node.type === "short_var_declaration" ? ":=" : "=";
  const index = text.indexOf(operator);
  if (index < 0) return undefined;
  const targets = splitTopLevel(text.slice(0, index)).map((item) => item.trim());
  const expressions = splitTopLevel(text.slice(index + operator.length)).map((item) => item.trim());
  return {
    targets,
    expressions,
    line: node.startPosition.row + 1,
    start: node.startIndex,
    end: node.endIndex,
    visibilityEnd: operator === ":=" && node.parent !== null && [
      "if_statement",
      "expression_switch_statement",
      "type_switch_statement",
      "for_statement",
    ].includes(node.parent.type) ? node.parent.endIndex : Number.POSITIVE_INFINITY,
    scopeId,
    declaration: operator === ":=",
    terminatesBranch: enclosingTerminatingBranch(node, source),
    ...enclosingIfArm(node),
  };
}

function variableFact(source: string, node: Node, scopeId: string): Assignment | undefined {
  const values = node.namedChildren.find((child) => child.type === "expression_list");
  const targets = node.namedChildren
    .filter((child) => child.type === "identifier" && (values === undefined || child.endIndex <= values.startIndex))
    .map((child) => sourceText(child, source));
  if (targets.length === 0) return undefined;
  return {
    targets,
    expressions: values?.namedChildren.map((child) => sourceText(child, source)) ?? [],
    line: node.startPosition.row + 1,
    start: node.startIndex,
    end: node.endIndex,
    visibilityEnd: Number.POSITIVE_INFINITY,
    scopeId,
    declaration: true,
    terminatesBranch: enclosingTerminatingBranch(node, source),
    ...enclosingIfArm(node),
  };
}

function enclosingIfArm(node: Node): Pick<Assignment, "branchGroup" | "branchArm" | "branchExhaustive"> {
  let current: Node | null = node;
  while (current !== null && !["function_declaration", "method_declaration", "func_literal"].includes(current.type)) {
    if (current.type === "block" && current.parent?.type === "if_statement") {
      const statement = current.parent;
      const consequence = statement.childForFieldName("consequence");
      const alternative = statement.childForFieldName("alternative");
      if (consequence?.id === current.id || alternative?.id === current.id) {
        return {
          branchGroup: `if:${statement.startIndex}`,
          branchArm: consequence?.id === current.id ? "then" : "else",
          branchExhaustive: alternative?.type === "block",
        };
      }
    }
    current = current.parent;
  }
  return {};
}

function enclosingTerminatingBranch(node: Node, source: string): boolean {
  let current = node.parent;
  while (current !== null && current.type !== "function_declaration" && current.type !== "method_declaration" &&
    current.type !== "func_literal") {
    if (current.type === "block") {
      if (current.parent !== null && ["function_declaration", "method_declaration", "func_literal"].includes(current.parent.type)) {
        return false;
      }
      if (blockTerminates(current, source)) return true;
    }
    current = current.parent;
  }
  return false;
}

function callFact(source: string, node: Node, scopeId: string): Call | undefined {
  const fn = node.childForFieldName("function");
  const args = node.childForFieldName("arguments");
  if (fn === null || args === null) return undefined;
  const functionText = sourceText(fn, source).replace(/\s+/g, "");
  const name = functionText.match(/([A-Za-z_]\w*)$/)?.[1];
  if (name === undefined) return undefined;
  const guard = commaOkGuard(node, source);
  return {
    name,
    functionText,
    args: args.namedChildren.map((argument) => sourceText(argument, source)),
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    text: sourceText(node, source).trim(),
    start: node.startIndex,
    scopeId,
    executable: nodeIsReachable(node, source) && !insideUninvokedFunctionLiteral(node, source),
    hitEscape: guard?.kind === "hit",
    ...(guard?.kind === "miss" ? { missBranch: guard.branch } : {}),
  };
}

function insideUninvokedFunctionLiteral(node: Node, source: string): boolean {
  let current: Node | null = node.parent;
  while (current !== null && !["function_declaration", "method_declaration"].includes(current.type)) {
    if (current.type === "func_literal") {
      let wrapper: Node = current;
      while (wrapper.parent !== null && wrapper.parent.type === "parenthesized_expression") wrapper = wrapper.parent;
      const parent = wrapper.parent;
      const directlyInvoked = parent?.type === "call_expression" &&
        parent.childForFieldName("function")?.id === wrapper.id;
      const passedToKnownExecutingCall = parent?.type === "argument_list" &&
        parent.parent?.type === "call_expression" && callbackIsSynchronouslyExecuted(parent.parent, wrapper, source);
      const assignedAndInvoked = localFunctionLiteralDefinitelyInvoked(current);
      if (!directlyInvoked && !passedToKnownExecutingCall && !assignedAndInvoked) return true;
    }
    current = current.parent;
  }
  return false;
}

function callbackIsSynchronouslyExecuted(call: Node, literal: Node, source: string): boolean {
  const fn = call.childForFieldName("function")?.text.replace(/\s+/g, "") ?? "";
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.at(-1)?.id !== literal.id) return false;
  const selected = fn.match(/^([A-Za-z_]\w*)\.(?:Do|DoChan)$/)?.[1];
  if (selected === undefined) return false;
  let root = call;
  while (root.parent !== null) root = root.parent;
  const aliases = importAliases(source, root, "golang.org/x/sync/singleflight", "singleflight");
  if (aliases.size === 0) return false;
  return descendants(root, "var_spec").some((spec) => {
    let owner = spec.parent;
    while (owner !== null && owner.type !== "source_file" &&
      !["function_declaration", "method_declaration", "func_literal"].includes(owner.type)) owner = owner.parent;
    if (owner?.type !== "source_file") return false;
    if (!declaredNames(spec, source).includes(selected)) return false;
    const compact = sourceText(spec, source).replace(/\s+/g, "");
    return [...aliases].some((alias) => new RegExp(
      `^${escapeRegExp(selected)}(?:\\*?${escapeRegExp(alias)}\\.Group|=(?:&)?${escapeRegExp(alias)}\\.Group\\{)`,
    ).test(compact));
  });
}

function localFunctionLiteralDefinitelyInvoked(literal: Node): boolean {
  let assignment: Node | null = literal.parent;
  while (assignment !== null && !["short_var_declaration", "assignment_statement", "var_spec"].includes(assignment.type)) {
    if (["statement_list", "block", "func_literal", "function_declaration", "method_declaration"].includes(assignment.type)) {
      return false;
    }
    assignment = assignment.parent;
  }
  if (assignment === null) return false;
  const statementList = assignment.parent?.type === "statement_list"
    ? assignment.parent
    : assignment.parent?.parent?.type === "statement_list" ? assignment.parent.parent : undefined;
  if (statementList === undefined) return false;
  const name = assignedSingleIdentifier(assignment);
  if (name === undefined) return false;
  const laterStatements = statementList.namedChildren.filter((statement) => statement.startIndex > assignment!.endIndex);
  for (const statement of laterStatements) {
    if (declarationAssignsName(statement, name)) return false;
    const call = directInvocationStatement(statement);
    if (call?.childForFieldName("function")?.type === "identifier" &&
      call.childForFieldName("function")!.text === name) return true;
  }
  return false;
}

function assignedSingleIdentifier(declaration: Node): string | undefined {
  const left = declaration.type === "var_spec"
    ? declaration.namedChildren.filter((child) => child.type === "identifier")
    : declaration.childForFieldName("left")?.namedChildren ?? [];
  if (left.length !== 1 || left[0]?.type !== "identifier") return undefined;
  return left[0].text;
}

function declarationAssignsName(statement: Node, name: string): boolean {
  return descendants(statement, "short_var_declaration")
    .concat(descendants(statement, "assignment_statement"))
    .concat(descendants(statement, "var_spec"))
    .some((declaration) => {
      if (declaration.type === "var_spec") return declaration.namedChildren.some((child) => child.type === "identifier" && child.text === name);
      return (declaration.childForFieldName("left")?.namedChildren ?? [])
        .some((child) => child.type === "identifier" && child.text === name);
    });
}

function directInvocationStatement(statement: Node): Node | undefined {
  let candidate = statement;
  if (["go_statement", "defer_statement", "expression_statement"].includes(candidate.type)) {
    candidate = candidate.namedChildren[0] ?? candidate;
  }
  return candidate.type === "call_expression" ? candidate : undefined;
}

function nodeIsReachable(node: Node, source: string): boolean {
  let current: Node | null = node;
  while (current?.parent !== null && current?.parent !== undefined) {
    const parent: Node = current.parent;
    if (parent.type === "statement_list") {
      const index = parent.namedChildren.findIndex((candidate) => candidate.id === current!.id);
      if (index >= 0 && parent.namedChildren.slice(0, index).some((item) => statementAlwaysTerminates(item, source))) {
        return false;
      }
    }
    current = parent;
  }
  return true;
}

function statementAlwaysTerminates(node: Node, source: string): boolean {
  if (["return_statement", "break_statement", "continue_statement", "goto_statement"].includes(node.type)) return true;
  if (node.type === "expression_statement") {
    const call = node.namedChildren[0];
    const fn = call?.type === "call_expression" ? call.childForFieldName("function") : null;
    if (fn?.type === "identifier" && sourceText(fn, source) === "panic" &&
      !identifierShadowedAt(node, "panic", source)) return true;
  }
  if (node.type !== "if_statement") return false;
  const consequence = node.childForFieldName("consequence");
  const alternative = node.childForFieldName("alternative");
  return consequence !== null && alternative !== null && blockTerminates(consequence, source) &&
    (alternative.type === "if_statement" ? statementAlwaysTerminates(alternative, source) : blockTerminates(alternative, source));
}

function commaOkGuard(value: Node, source: string):
  { kind: "hit" } | { kind: "miss"; branch: { start: number; end: number } } | undefined {
  let assignment: Node | null = value.parent;
  while (assignment !== null && assignment.type !== "short_var_declaration" && assignment.type !== "assignment_statement") {
    if (assignment.type === "statement_list" || assignment.type === "block") return undefined;
    assignment = assignment.parent;
  }
  if (assignment === null) return undefined;
  const right = assignment.childForFieldName("right")?.namedChildren ?? [];
  if (right.length !== 1 || right[0]!.id !== value.id) return undefined;
  const left = assignment.childForFieldName("left")?.namedChildren ?? [];
  const okNode = left[1];
  if (left.length !== 2 || okNode?.type !== "identifier") return undefined;
  const ok = sourceText(okNode, source);

  let guard: Node | undefined;
  if (assignment.parent?.type === "if_statement") {
    guard = assignment.parent;
  } else if (assignment.parent?.type === "statement_list") {
    const siblings = assignment.parent.namedChildren;
    const index = siblings.findIndex((candidate) => candidate.id === assignment!.id);
    const candidate = siblings[index + 1];
    if (candidate?.type === "if_statement") guard = candidate;
  }
  if (guard === undefined) return undefined;
  const condition = guard.childForFieldName("condition");
  const consequence = guard.childForFieldName("consequence");
  if (condition === null || consequence === null) return undefined;
  const compact = sourceText(condition, source).replace(/\s+/g, "").replace(/^\((.*)\)$/, "$1");
  if (compact === ok && blockTerminates(consequence, source)) return { kind: "hit" };
  if (compact === `!${ok}`) {
    return { kind: "miss", branch: { start: consequence.startIndex, end: consequence.endIndex } };
  }
  return undefined;
}

function blockTerminates(block: Node, source: string): boolean {
  const statements = block.namedChildren.find((node) => node.type === "statement_list")?.namedChildren ?? [];
  const final = statements.at(-1);
  return final !== undefined && statementAlwaysTerminates(final, source);
}

function fixedAdmissions(source: string, body: Node, scopes: Map<string, LexicalScope>): AdmissionFact[] {
  const result: AdmissionFact[] = [];
  for (const statement of descendants(body, "expression_switch_statement")) {
    if (statement.childForFieldName("initializer") !== null) continue;
    const key = statement.childForFieldName("value");
    if (key === null) continue;
    const cases = statement.namedChildren.filter((node) => node.type === "expression_case");
    const defaultCase = statement.namedChildren.find((node) => node.type === "default_case");
    if (cases.length === 0 || defaultCase === undefined || !caseTerminates(defaultCase)) continue;
    const finite = cases.every((item) => {
      const expressions = item.namedChildren.find((node) => node.type === "expression_list")?.namedChildren ?? [];
      return expressions.length > 0 && expressions.every((expression) =>
        expression.type === "interpreted_string_literal" || expression.type === "raw_string_literal");
    });
    if (!finite) continue;
    result.push({
      key: sourceText(key, source),
      start: statement.startIndex,
      scopeId: scopeForNode(statement, scopes).id,
    });
  }
  return result;
}

function caseTerminates(caseNode: Node): boolean {
  const statements = caseNode.namedChildren.find((node) => node.type === "statement_list")?.namedChildren ?? [];
  const final = statements.at(-1);
  return final?.type === "return_statement";
}

function capacityGuardFacts(source: string, body: Node, scopes: Map<string, LexicalScope>): CapacityGuardFact[] {
  const result: CapacityGuardFact[] = [];
  for (const statement of descendants(body, "if_statement")) {
    const condition = statement.childForFieldName("condition");
    const consequence = statement.childForFieldName("consequence");
    if (condition === null || consequence === null) continue;
    if (identifierShadowedAt(statement, "len", source)) continue;
    const match = sourceText(condition, source).replace(/\s+/g, "")
      .match(/^len\(([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\)(?:>=|>)([0-9][0-9A-Fa-f_xXoObB]*|[A-Za-z_]\w*)$/);
    if (match === null) continue;
    const returns = blockTerminates(consequence, source);
    const evicts = evictsRangedEntry(consequence, source, match[1]!);
    if (!returns && !evicts) continue;
    result.push({
      cache: match[1]!,
      bound: match[2]!,
      start: statement.startIndex,
      end: statement.endIndex,
      scopeId: scopeForNode(statement, scopes).id,
      kind: returns ? "return" : "ranged-eviction",
      boundLocallyShadowed: /^[A-Za-z_]\w*$/.test(match[2]!) && locallyShadowedAt(statement, match[2]!, source),
    });
  }
  return result;
}

function identifierShadowedAt(reference: Node, name: string, source: string): boolean {
  if (locallyShadowedAt(reference, name, source)) return true;
  let root = reference;
  while (root.parent !== null) root = root.parent;
  return [
    ...descendants(root, "var_spec"),
    ...descendants(root, "const_spec"),
    ...descendants(root, "function_declaration"),
    ...descendants(root, "type_spec"),
  ].some((declaration) => {
    if (declaration.type !== "function_declaration" && declaration.parent?.parent?.type !== "source_file" &&
      declaration.parent?.type !== "source_file") return false;
    return declaredNames(declaration, source).includes(name);
  });
}

function locallyShadowedAt(reference: Node, name: string, source: string): boolean {
  let callable: Node | null = reference;
  while (callable !== null && !["function_declaration", "method_declaration", "func_literal"].includes(callable.type)) {
    callable = callable.parent;
  }
  if (callable !== null) {
    const parameterLists = [callable.childForFieldName("receiver"), callable.childForFieldName("parameters")];
    if (parameterLists.some((list) => list !== null && descendants(list!, "parameter_declaration")
      .some((parameter) => declaredNames(parameter, source).includes(name)))) return true;
    const body = callable.childForFieldName("body");
    if (body !== null) {
      const declarations = [
        ...descendants(body, "short_var_declaration"),
        ...descendants(body, "var_spec"),
        ...descendants(body, "const_spec"),
        ...descendants(body, "range_clause"),
        ...descendants(body, "receive_statement"),
        ...descendants(body, "type_switch_statement"),
      ];
      if (declarations.some((declaration) => declaration.startIndex < reference.startIndex &&
        declarationVisibleAt(declaration, reference) && declaredNames(declaration, source).includes(name))) return true;
    }
  }
  return false;
}

function declaredNames(declaration: Node, source: string): string[] {
  if (declaration.type === "function_declaration" || declaration.type === "type_spec") {
    const name = declaration.childForFieldName("name");
    return name === null ? [] : [sourceText(name, source)];
  }
  if (declaration.type === "range_clause" || declaration.type === "receive_statement" ||
    declaration.type === "type_switch_statement") {
    if (!sourceText(declaration, source).includes(":=")) return [];
    const selected = declaration.type === "type_switch_statement"
      ? declaration.namedChildren.find((child) => child.type === "expression_list")?.namedChildren
      : declaration.childForFieldName("left")?.namedChildren;
    return (selected ?? [])
      .filter((child) => child.type === "identifier")
      .map((child) => sourceText(child, source));
  }
  const type = declaration.childForFieldName("type");
  const left = declaration.childForFieldName("left")?.namedChildren;
  const children = left ?? declaration.namedChildren;
  return children.filter((child) => child.type === "identifier" && (type === null || child.endIndex <= type.startIndex))
    .map((child) => sourceText(child, source));
}

function declarationVisibleAt(declaration: Node, reference: Node): boolean {
  let scope = declaration.parent;
  const lexicalScopes = new Set([
    "block", "source_file", "if_statement", "for_statement", "expression_switch_statement",
    "type_switch_statement", "expression_case", "type_case", "communication_case",
  ]);
  while (scope !== null && !lexicalScopes.has(scope.type)) scope = scope.parent;
  return scope !== null && reference.startIndex >= scope.startIndex && reference.endIndex <= scope.endIndex;
}

function evictsRangedEntry(consequence: Node, source: string, cache: string): boolean {
  const topLevel = consequence.namedChildren.find((node) => node.type === "statement_list")?.namedChildren ?? [];
  return topLevel.some((statement) => {
    if (statement.type !== "for_statement") return false;
    const clause = statement.namedChildren.find((node) => node.type === "range_clause");
    const loopBody = statement.childForFieldName("body") ?? statement.namedChildren.find((node) => node.type === "block");
    if (clause === undefined || loopBody === null || loopBody === undefined) return false;
    const ranged = clause.namedChildren.at(-1);
    const names = clause.namedChildren.find((node) => node.type === "expression_list")?.namedChildren ?? [];
    const victim = names[0];
    if (ranged === undefined || sourceText(ranged, source).replace(/\s+/g, "") !== cache || victim?.type !== "identifier") {
      return false;
    }
    const loopStatements = loopBody.namedChildren.find((node) => node.type === "statement_list")?.namedChildren ?? [];
    if (loopStatements.at(-1)?.type !== "break_statement") return false;
    const victimName = sourceText(victim, source);
    return loopStatements.slice(0, -1).some((loopStatement) => {
      if (loopStatement.type !== "expression_statement") return false;
      const call = loopStatement.namedChildren[0];
      if (call?.type !== "call_expression") return false;
      const fn = call.childForFieldName("function");
      const args = call.childForFieldName("arguments")?.namedChildren ?? [];
      return fn?.type === "identifier" && sourceText(fn, source) === "delete" && args.length === 2 &&
        sourceText(args[0]!, source).replace(/\s+/g, "") === cache && sourceText(args[1]!, source) === victimName;
    });
  });
}

function cacheAccesses(
  source: string,
  body: Node,
  scopes: Map<string, LexicalScope>,
): CacheAccess[] {
  const insertions = new Map<string, CacheAccess>();
  for (const assignment of descendants(body, "assignment_statement")) {
    if (!nodeIsReachable(assignment, source) || insideUninvokedFunctionLiteral(assignment, source)) continue;
    const text = sourceText(assignment, source);
    const left = text.slice(0, text.indexOf("="));
    for (const match of left.matchAll(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\[([^\]]+)\]/g)) {
      const cacheText = match[1]!;
      const access: CacheAccess = {
        cacheText,
        key: match[2]!.trim(),
        line: assignment.startPosition.row + 1,
        endLine: assignment.endPosition.row + 1,
        text: text.trim(),
        value: text.slice(text.indexOf("=") + 1).trim(),
        kind: "insert",
        start: assignment.startIndex,
        end: assignment.endIndex,
        scopeId: scopeForNode(assignment, scopes).id,
        hitEscape: false,
      };
      insertions.set(`${assignment.startIndex}:${cacheText}`, access);
    }
  }

  const accesses: CacheAccess[] = [...insertions.values()];
  for (const index of descendants(body, "index_expression")) {
    if (!nodeIsReachable(index, source) || insideUninvokedFunctionLiteral(index, source)) continue;
    const text = sourceText(index, source);
    const match = text.match(/^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\[([\s\S]+)\]\s*$/);
    if (match === null) continue;
    const cacheText = match[1]!;
    const isInsertion = [...insertions.values()].some((item) =>
      item.line === index.startPosition.row + 1 && item.cacheText === cacheText);
    if (isInsertion) continue;
    const guard = commaOkGuard(index, source);
    accesses.push({
      cacheText,
      key: match[2]!.trim(),
      line: index.startPosition.row + 1,
      endLine: index.endPosition.row + 1,
      text: text.trim(),
      value: "",
      kind: "lookup",
      start: index.startIndex,
      end: index.endIndex,
      scopeId: scopeForNode(index, scopes).id,
      hitEscape: guard?.kind === "hit",
      ...(guard?.kind === "miss" ? { missBranch: guard.branch } : {}),
    });
  }
  return accesses.sort((left, right) => left.line - right.line);
}

function resolveCacheAt(
  fn: FunctionFact,
  expression: string,
  position: number,
  scopeId: string,
  caches: Map<string, PersistentCache>,
): string | undefined {
  const aliases = new Map<string, string>();
  for (const cache of caches.values()) {
    const globalPrefix = `global:${fn.scope}:`;
    if (cache.id.startsWith(globalPrefix)) aliases.set(cache.id.slice(globalPrefix.length), cache.id);
  }
  for (const [selector, cacheId] of fn.receiverCaches) aliases.set(selector, cacheId);

  const ancestors = scopeAncestors(fn.scopes, scopeId);
  for (const parameter of fn.scopes.get(fn.rootScopeId)?.parameters ?? []) {
    if (!fn.receiverCaches.has(parameter.name)) aliases.delete(parameter.name);
  }
  const assignments = fn.assignments.filter((item) =>
    item.start < position && position <= item.visibilityEnd && ancestors.includes(item.scopeId));
  const shadows = ancestors.filter((ancestor) => ancestor !== fn.rootScopeId)
    .flatMap((ancestor) => (fn.scopes.get(ancestor)?.parameters ?? []).map((parameter, index) => ({
      start: fn.scopes.get(ancestor)!.start,
      name: parameter.name,
      argument: fn.scopes.get(ancestor)?.invocationArguments?.[index],
    })));
  const positions = [...new Set([
    ...assignments.map((assignment) => assignment.start),
    ...shadows.map((shadow) => shadow.start),
  ])].sort((left, right) => left - right);
  for (const eventPosition of positions) {
    for (const shadow of shadows.filter((candidate) => candidate.start === eventPosition)) {
      const cacheId = shadow.argument === undefined ? undefined : aliases.get(shadow.argument.replace(/\s+/g, ""));
      if (cacheId === undefined) aliases.delete(shadow.name);
      else aliases.set(shadow.name, cacheId);
      for (const name of [...aliases.keys()]) if (name.startsWith(`${shadow.name}.`)) aliases.delete(name);
    }
    for (const assignment of assignments.filter((candidate) => candidate.start === eventPosition)) {
      assignment.targets.forEach((target, index) => {
        if (!/^[A-Za-z_]\w*$/.test(target) || target === "_") return;
        const value = assignment.expressions[index] ?? (index === 0 ? assignment.expressions[0] : undefined);
        const normalized = value?.replace(/\s+/g, "");
        const cacheId = normalized === undefined ? undefined : aliases.get(normalized);
        if (cacheId === undefined) aliases.delete(target);
        else aliases.set(target, cacheId);
      });
    }
  }
  return aliases.get(expression.replace(/\s+/g, ""));
}

function uniqueFunctionsByName(functions: FunctionFact[]): Map<string, FunctionFact> {
  const grouped = new Map<string, FunctionFact[]>();
  for (const fn of functions) grouped.set(fn.name, [...(grouped.get(fn.name) ?? []), fn]);
  return new Map([...grouped].filter(([, values]) => values.length === 1).map(([name, values]) => [name, values[0]!]));
}

function calculateReturnDependencies(
  functions: FunctionFact[],
  byName: Map<string, FunctionFact>,
): Map<string, Dependencies> {
  const summaries = new Map<string, Dependencies>();
  for (let pass = 0; pass < functions.length + 2; pass += 1) {
    let changed = false;
    for (const fn of functions) {
      const seeds = new Map<string, Dependencies>();
      fn.params.forEach((parameter, index) => seeds.set(parameter.name, new Set([`p:${index}`])));
      const next = union(...fn.returns
        .filter((item) => item.scopeId === fn.rootScopeId)
        .flatMap((item) => {
          const env = environmentAt(fn, item.start, item.scopeId, seeds, byName, summaries);
          return item.expressions.map((expression) => expressionDependencies(expression, env, byName, summaries));
        }));
      if (!sameDependencies(next, summaries.get(fn.id) ?? new Set())) {
        summaries.set(fn.id, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return summaries;
}

function calculateRequestParameterSeeds(
  functions: FunctionFact[],
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
): Map<string, Map<string, Dependencies>> {
  const seeds = new Map<string, Map<string, Dependencies>>();
  for (const fn of functions) {
    const map = new Map<string, Dependencies>();
    fn.params.forEach((parameter, index) => {
      const dependencies = new Set([`p:${index}`]);
      if (parameter.httpRequest) dependencies.add("request-object");
      map.set(parameter.name, dependencies);
    });
    seeds.set(fn.id, map);
  }

  for (let pass = 0; pass < functions.length + 2; pass += 1) {
    let changed = false;
    for (const caller of functions) {
      for (const call of caller.calls) {
        const callee = byName.get(call.name);
        if (callee === undefined) continue;
        const env = environmentAt(caller, call.start, call.scopeId, seeds.get(caller.id) ?? new Map(), byName, summaries);
        const target = seeds.get(callee.id)!;
        call.args.forEach((argument, index) => {
          const parameter = callee.params[index];
          if (parameter === undefined) return;
          const deps = expressionDependencies(argument, env, byName, summaries);
          const propagated = new Set([...deps].filter((dep) =>
            dep === "request" || dep === "request-object" || dep.startsWith("origin:")));
          if (propagated.size === 0) return;
          const existing = target.get(parameter.name) ?? new Set<string>();
          const combined = union(existing, propagated);
          if (!sameDependencies(existing, combined)) {
            target.set(parameter.name, combined);
            changed = true;
          }
        });
      }
    }
    if (!changed) break;
  }
  return seeds;
}

function environmentAt(
  fn: FunctionFact,
  position: number,
  scopeId: string,
  seeds: Map<string, Dependencies>,
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
): Map<string, Dependencies> {
  const env = new Map<string, Dependencies>();
  for (const [name, deps] of seeds) env.set(name, new Set(deps));
  const ancestors = scopeAncestors(fn.scopes, scopeId);
  const assignments = fn.assignments.filter((item) => {
    if (item.start >= position || position > item.visibilityEnd) return false;
    if (ancestors.includes(item.scopeId)) return true;
    return !item.declaration && !item.terminatesBranch &&
      callableScope(fn.scopes, item.scopeId) === callableScope(fn.scopes, scopeId);
  });
  const shadows = ancestors.filter((ancestor) => ancestor !== fn.rootScopeId)
    .flatMap((ancestor) => (fn.scopes.get(ancestor)?.parameters ?? []).map((parameter, index) => ({
      start: fn.scopes.get(ancestor)!.start,
      parameter,
      argument: fn.scopes.get(ancestor)?.invocationArguments?.[index],
    })));
  const positions = [...new Set([
    ...assignments.map((assignment) => assignment.start),
    ...shadows.map((shadow) => shadow.start),
  ])].sort((left, right) => left - right);
  const handledBranches = new Set<string>();
  for (const eventPosition of positions) {
    for (const { parameter, argument } of shadows.filter((shadow) => shadow.start === eventPosition)) {
      const deps = argument === undefined
        ? new Set<string>()
        : expressionDependencies(argument, env, byName, summaries);
      if (argument === undefined && parameter.httpRequest) deps.add("request-object");
      env.set(parameter.name, deps);
    }
    for (const assignment of assignments.filter((candidate) => candidate.start === eventPosition)) {
      if (assignment.branchGroup !== undefined && assignment.branchExhaustive === true) {
        if (handledBranches.has(assignment.branchGroup)) continue;
        const grouped = assignments.filter((candidate) => candidate.branchGroup === assignment.branchGroup);
        const thenAssignments = grouped.filter((candidate) => candidate.branchArm === "then");
        const elseAssignments = grouped.filter((candidate) => candidate.branchArm === "else");
        if (thenAssignments.length > 0 && elseAssignments.length > 0) {
          const base = new Map([...env].map(([name, deps]) => [name, new Set(deps)]));
          const thenEnvironment = replayDependencyAssignments(thenAssignments, base, byName, summaries);
          const elseEnvironment = replayDependencyAssignments(elseAssignments, base, byName, summaries);
          const names = new Set([
            ...thenAssignments.flatMap((candidate) => candidate.targets),
            ...elseAssignments.flatMap((candidate) => candidate.targets),
          ]);
          for (const name of names) {
            if (!/^[A-Za-z_]\w*$/.test(name) || name === "_") continue;
            env.set(name, union(thenEnvironment.get(name) ?? new Set(), elseEnvironment.get(name) ?? new Set()));
          }
          handledBranches.add(assignment.branchGroup);
          continue;
        }
      }
      const next = new Map<string, Dependencies>();
      assignment.targets.forEach((target, index) => {
        if (!/^[A-Za-z_]\w*$/.test(target) || target === "_") return;
        const expression = assignment.expressions[index] ?? (index === 0 ? assignment.expressions[0] : undefined);
        next.set(target, expression === undefined
          ? new Set()
          : assignedDependencies(expression, env, byName, summaries));
      });
      const conditional = !ancestors.includes(assignment.scopeId) &&
        conditionallyExecutedRelativeTo(fn.scopes, assignment.scopeId, scopeId);
      for (const [target, deps] of next) {
        env.set(target, conditional ? union(env.get(target) ?? new Set(), deps) : deps);
      }
    }
  }
  return env;
}

function replayDependencyAssignments(
  assignments: Assignment[],
  base: Map<string, Dependencies>,
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
): Map<string, Dependencies> {
  const environment = new Map([...base].map(([name, deps]) => [name, new Set(deps)]));
  for (const assignment of assignments.sort((left, right) => left.start - right.start)) {
    const next = new Map<string, Dependencies>();
    assignment.targets.forEach((target, index) => {
      if (!/^[A-Za-z_]\w*$/.test(target) || target === "_") return;
      const expression = assignment.expressions[index] ?? (index === 0 ? assignment.expressions[0] : undefined);
      next.set(target, expression === undefined
        ? new Set()
        : assignedDependencies(expression, environment, byName, summaries));
    });
    for (const [target, deps] of next) environment.set(target, deps);
  }
  return environment;
}

function assignedDependencies(
  expression: string,
  env: Map<string, Dependencies>,
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
): Dependencies {
  const dependencies = expressionDependencies(expression, env, byName, summaries);
  if (requestOrigins(dependencies).size === 0 || /^\s*\(?[A-Za-z_]\w*\)?\s*$/.test(expression)) return dependencies;
  for (const dependency of [...dependencies]) if (dependency.startsWith("value:")) dependencies.delete(dependency);
  dependencies.add(valueIdentity(expression, env));
  return dependencies;
}

function valueIdentity(expression: string, environment: Map<string, Dependencies>): string {
  let canonical = maskGoNonCode(expression, false).replace(/\s+/g, "");
  const identifiers = [...environment.keys()].sort((left, right) => right.length - left.length);
  for (const identifier of identifiers) {
    const dependencies = environment.get(identifier) ?? new Set<string>();
    const values = [...dependencies].filter((dependency) => dependency.startsWith("value:")).sort();
    const parameters = [...dependencies].filter((dependency) => /^p:\d+$/.test(dependency)).sort();
    const origins = [...dependencies].filter((dependency) => dependency.startsWith("origin:")).sort();
    const identity = values.length > 0 ? values : parameters.length > 0 ? parameters : origins;
    if (identity.length === 0) continue;
    canonical = canonical.replace(new RegExp(`\\b${escapeRegExp(identifier)}\\b`, "g"), `{${identity.join("|")}}`);
  }
  return `value:canonical:${canonical}`;
}

function expressionDependencies(
  expression: string,
  env: Map<string, Dependencies>,
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
): Dependencies {
  const executable = maskGoNonCode(expression);
  const deps = new Set<string>();
  const requestReceivers = [...env].filter(([, value]) => value.has("request-object")).map(([name]) => name);
  for (const receiver of requestReceivers) {
    const escaped = escapeRegExp(receiver);
    const sourcePattern = new RegExp(
      `\\b${escaped}(?:\\.(?:Cookie|PathValue)\\s*\\([^)]*\\)|\\.Header\\.Get\\s*\\([^)]*\\)|` +
      `\\.URL\\.Query\\s*\\(\\s*\\)\\.Get\\s*\\([^)]*\\)|` +
      `\\.(?:Header|URL\\.Query\\s*\\(\\s*\\))\\s*\\[[^\\]]+\\]|\\.URL\\.(?:Path|RawPath))`,
      "g",
    );
    for (const match of executable.matchAll(sourcePattern)) {
      deps.add("request");
      const original = expression.slice(match.index ?? 0, (match.index ?? 0) + match[0]!.length);
      deps.add(`origin:${original.replace(/\s+/g, "")}`);
    }
  }
  for (const identifier of executable.match(/[A-Za-z_]\w*/g) ?? []) {
    for (const dependency of env.get(identifier) ?? []) deps.add(dependency);
  }

  const call = parseOuterCall(executable);
  if (call !== undefined) {
    const callee = byName.get(call.name);
    if (callee !== undefined) {
      for (const dependency of summaries.get(callee.id) ?? []) {
        const parameter = dependency.match(/^p:(\d+)$/)?.[1];
        if (parameter === undefined) {
          deps.add(dependency);
          continue;
        }
        const argument = call.args[Number(parameter)];
        if (argument === undefined) continue;
        for (const mapped of expressionDependencies(argument, env, byName, summaries)) deps.add(mapped);
      }
    }
  }
  if (requestOrigins(deps).size > 0 && !/^\s*\(?[A-Za-z_]\w*\)?\s*$/.test(expression)) {
    deps.add(valueIdentity(expression, env));
  }
  return deps;
}

function requestOrigins(dependencies: Dependencies): Set<string> {
  return new Set([...dependencies].filter((item) => item.startsWith("origin:")));
}

function sameRequestOrigin(left: Dependencies | Set<string>, right: Dependencies | Set<string>): boolean {
  const leftOrigins = new Set([...left].filter((item) => item.startsWith("origin:")));
  const rightOrigins = new Set([...right].filter((item) => item.startsWith("origin:")));
  if (![...leftOrigins].some((item) => rightOrigins.has(item))) return false;
  const leftParameters = new Set([...left].filter((item) => /^p:\d+$/.test(item)));
  const rightParameters = new Set([...right].filter((item) => /^p:\d+$/.test(item)));
  if (leftParameters.size > 0 && rightParameters.size > 0 &&
    ![...leftParameters].some((item) => rightParameters.has(item))) return false;
  const leftValues = new Set([...left].filter((item) => item.startsWith("value:")));
  const rightValues = new Set([...right].filter((item) => item.startsWith("value:")));
  if (leftValues.size > 0 || rightValues.size > 0) {
    return [...leftValues].some((item) => rightValues.has(item));
  }
  return true;
}

function requestCallEdges(
  functions: FunctionFact[],
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
  seeds: Map<string, Map<string, Dependencies>>,
): CallEdge[] {
  const edges: CallEdge[] = [];
  for (const caller of functions) {
    for (const call of caller.calls) {
      const callee = byName.get(call.name);
      if (callee === undefined) continue;
      const env = environmentAt(caller, call.start, call.scopeId, seeds.get(caller.id) ?? new Map(), byName, summaries);
      if (call.args.some((argument) => requestOrigins(expressionDependencies(argument, env, byName, summaries)).size > 0)) {
        edges.push({
          caller,
          callee,
          line: call.line,
          endLine: call.endLine,
          start: call.start,
          scopeId: call.scopeId,
          call,
        });
      }
    }
  }
  return edges;
}

function mapParameterDependencies(
  dependencies: Dependencies,
  call: Call,
  environment: Map<string, Dependencies>,
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
): Dependencies {
  const mapped = new Set<string>();
  let mappedParameter = false;
  for (const dependency of dependencies) {
    const parameter = dependency.match(/^p:(\d+)$/)?.[1];
    if (parameter === undefined) continue;
    const argument = call.args[Number(parameter)];
    if (argument === undefined) continue;
    mappedParameter = true;
    for (const item of expressionDependencies(argument, environment, byName, summaries)) mapped.add(item);
  }
  return mappedParameter ? mapped : new Set(dependencies);
}

function cacheLookupSummaries(
  functions: FunctionFact[],
  byName: Map<string, FunctionFact>,
  returnDependencies: Map<string, Dependencies>,
  caches: Map<string, PersistentCache>,
): Map<string, Array<{ cacheId: string; parameter: number }>> {
  const summaries = new Map<string, Array<{ cacheId: string; parameter: number }>>();
  for (const fn of functions) {
    const seeds = new Map<string, Dependencies>();
    fn.params.forEach((parameter, index) => seeds.set(parameter.name, new Set([`p:${index}`])));
    for (const access of fn.accesses.filter((item) => item.kind === "lookup")) {
      const cacheId = resolveCacheAt(fn, access.cacheText, access.start, access.scopeId, caches);
      if (cacheId === undefined) continue;
      access.cacheId = cacheId;
      const env = environmentAt(fn, access.start, access.scopeId, seeds, byName, returnDependencies);
      const deps = expressionDependencies(access.key, env, byName, returnDependencies);
      for (const dependency of deps) {
        const index = dependency.match(/^p:(\d+)$/)?.[1];
        if (index !== undefined) summaries.set(fn.name, [...(summaries.get(fn.name) ?? []), { cacheId, parameter: Number(index) }]);
      }
    }
  }
  return summaries;
}

function findCacheLookup(
  fn: FunctionFact,
  insertion: CacheAccess,
  keyOrigins: Set<string>,
  seeds: Map<string, Dependencies>,
  summaries: Map<string, Array<{ cacheId: string; parameter: number }>>,
  byName: Map<string, FunctionFact>,
  returnDependencies: Map<string, Dependencies>,
  caches: Map<string, PersistentCache>,
): { line: number; endLine: number; text: string; start: number; scopeId: string } | undefined {
  const direct = fn.accesses.find((item) => {
    if (item.kind !== "lookup" || item.start >= insertion.start) return false;
    const cacheId = resolveCacheAt(fn, item.cacheText, item.start, item.scopeId, caches);
    if (cacheId === undefined || cacheId !== insertion.cacheId) return false;
    item.cacheId = cacheId;
    const env = environmentAt(fn, item.start, item.scopeId, seeds, byName, returnDependencies);
    const protectedMiss = item.hitEscape ||
      (item.missBranch !== undefined && insertion.start > item.missBranch.start && insertion.end < item.missBranch.end);
    return protectedMiss &&
      sameRequestOrigin(expressionDependencies(item.key, env, byName, returnDependencies), keyOrigins);
  });
  if (direct !== undefined) return direct;
  for (const call of fn.calls.filter((item) => item.start < insertion.start)) {
    for (const summary of summaries.get(call.name) ?? []) {
      if (summary.cacheId !== insertion.cacheId) continue;
      const argument = call.args[summary.parameter];
      const env = environmentAt(fn, call.start, call.scopeId, seeds, byName, returnDependencies);
      const protectedMiss = call.hitEscape ||
        (call.missBranch !== undefined && insertion.start > call.missBranch.start && insertion.end < call.missBranch.end);
      if (argument !== undefined && protectedMiss && sameRequestOrigin(
        expressionDependencies(argument, env, byName, returnDependencies), keyOrigins)) {
        return {
          line: call.line,
          endLine: call.endLine,
          text: call.text,
          start: call.start,
          scopeId: call.scopeId,
        };
      }
    }
  }
  return undefined;
}

function findMaterialWork(
  fn: FunctionFact,
  insertion: CacheAccess,
  lookup: { line: number; endLine: number; text: string; start: number; scopeId: string },
  keyOrigins: Set<string>,
  seeds: Map<string, Dependencies>,
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
): Call | undefined {
  return fn.calls.find((call) => {
    if (call.start <= lookup.start || call.start >= insertion.end || !isMaterialCall(call, fn, byName)) return false;
    const env = environmentAt(fn, call.start, call.scopeId, seeds, byName, summaries);
    return materialFeedsInsertion(fn, call, insertion) && call.args.some((argument) =>
      sameRequestOrigin(expressionDependencies(argument, env, byName, summaries), keyOrigins));
  });
}

function materialFeedsInsertion(fn: FunctionFact, call: Call, insertion: CacheAccess): boolean {
  if (call.start >= insertion.start && call.start < insertion.end &&
    new RegExp(`\\b${escapeRegExp(call.functionText)}\\s*\\(`).test(maskGoNonCode(insertion.value))) return true;
  const values = new Map<string, boolean>();
  const ancestors = scopeAncestors(fn.scopes, insertion.scopeId);
  const assignments = fn.assignments.filter((item) =>
    item.line >= call.line && item.start < insertion.start &&
    (ancestors.includes(item.scopeId) ||
      (!item.declaration && !item.terminatesBranch &&
        callableScope(fn.scopes, item.scopeId) === callableScope(fn.scopes, insertion.scopeId))))
    .sort((left, right) => left.start - right.start);
  const shadowEvents = ancestors.filter((scopeId) => scopeId !== fn.rootScopeId)
    .flatMap((scopeId) => (fn.scopes.get(scopeId)?.parameters ?? []).map((parameter) => ({
      start: fn.scopes.get(scopeId)!.start,
      name: parameter.name,
    })));
  const positions = [
    ...new Set([...assignments.map((item) => item.start), ...shadowEvents.map((item) => item.start)]),
  ].sort((a, b) => a - b);
  const handledBranches = new Set<string>();
  for (const position of positions) {
    for (const shadow of shadowEvents.filter((item) => item.start === position)) values.set(shadow.name, false);
    for (const assignment of assignments.filter((item) => item.start === position)) {
      if (assignment.branchGroup !== undefined && assignment.branchExhaustive === true) {
        if (handledBranches.has(assignment.branchGroup)) continue;
        const grouped = assignments.filter((candidate) => candidate.branchGroup === assignment.branchGroup);
        const thenAssignments = grouped.filter((candidate) => candidate.branchArm === "then");
        const elseAssignments = grouped.filter((candidate) => candidate.branchArm === "else");
        if (thenAssignments.length > 0 && elseAssignments.length > 0) {
          const base = new Map(values);
          const thenValues = replayMaterialAssignments(thenAssignments, base, call);
          const elseValues = replayMaterialAssignments(elseAssignments, base, call);
          const names = new Set([
            ...thenAssignments.flatMap((candidate) => candidate.targets),
            ...elseAssignments.flatMap((candidate) => candidate.targets),
          ]);
          for (const name of names) {
            if (!/^[A-Za-z_]\w*$/.test(name) || name === "_") continue;
            values.set(name, (thenValues.get(name) ?? false) || (elseValues.get(name) ?? false));
          }
          handledBranches.add(assignment.branchGroup);
          continue;
        }
      }
      const next = new Map<string, boolean>();
      assignment.targets.forEach((target, index) => {
        if (!/^[A-Za-z_]\w*$/.test(target) || target === "_") return;
        const expression = assignment.expressions[index] ?? (index === 0 ? assignment.expressions[0] : undefined);
        if (expression === undefined) {
          next.set(target, false);
          return;
        }
        const executable = maskGoNonCode(expression);
        const direct = call.start >= assignment.start && call.start < assignment.end &&
          new RegExp(`\\b${escapeRegExp(call.functionText)}\\s*\\(`).test(executable);
        const derived = [...values].some(([name, contains]) => contains &&
          new RegExp(`\\b${escapeRegExp(name)}\\b`).test(executable));
        next.set(target, direct || derived);
      });
      const conditional = !ancestors.includes(assignment.scopeId) &&
        conditionallyExecutedRelativeTo(fn.scopes, assignment.scopeId, insertion.scopeId);
      for (const [target, contains] of next) {
        values.set(target, conditional ? (values.get(target) ?? false) || contains : contains);
      }
    }
  }
  const insertionValue = maskGoNonCode(insertion.value);
  return [...values].some(([name, contains]) => contains &&
    new RegExp(`\\b${escapeRegExp(name)}\\b`).test(insertionValue));
}

function replayMaterialAssignments(
  assignments: Assignment[],
  base: Map<string, boolean>,
  call: Call,
): Map<string, boolean> {
  const values = new Map(base);
  for (const assignment of assignments.sort((left, right) => left.start - right.start)) {
    const next = new Map<string, boolean>();
    assignment.targets.forEach((target, index) => {
      if (!/^[A-Za-z_]\w*$/.test(target) || target === "_") return;
      const expression = assignment.expressions[index] ?? (index === 0 ? assignment.expressions[0] : undefined);
      if (expression === undefined) {
        next.set(target, false);
        return;
      }
      const executable = maskGoNonCode(expression);
      const direct = call.start >= assignment.start && call.start < assignment.end &&
        new RegExp(`\\b${escapeRegExp(call.functionText)}\\s*\\(`).test(executable);
      const derived = [...values].some(([name, contains]) => contains &&
        new RegExp(`\\b${escapeRegExp(name)}\\b`).test(executable));
      next.set(target, direct || derived);
    });
    for (const [target, contains] of next) values.set(target, contains);
  }
  return values;
}

function isMaterialCall(
  call: Call,
  fn: FunctionFact,
  byName: Map<string, FunctionFact>,
  seen = new Set<string>(),
): boolean {
  const receiver = call.functionText.match(/^([A-Za-z_]\w*)\./)?.[1];
  if (receiver !== undefined && fn.httpAliases.has(receiver) && /^(?:Get|Post|Head)$/.test(call.name)) return true;
  if (receiver !== undefined && fn.fileAliases.has(receiver) && /^(?:Open|ReadFile)$/.test(call.name)) return true;
  if (/(?:fetch|Fetch|download|Download|retrieve|Retrieve|read|Read|load|Load).*(?:CDN|Cdn|Remote|remote|Bucket|bucket|Storage|storage|File|file|ObjectStore|objectStore)$/.test(call.name)) {
    const callee = byName.get(call.name);
    if (callee === undefined) return true;
    if (seen.has(callee.id)) return false;
    const nextSeen = new Set(seen).add(callee.id);
    return callee.calls.some((nested) => isMaterialCall(nested, callee, byName, nextSeen));
  }
  if (!/^(?:Query|QueryContext|QueryRow|QueryRowContext|Scan)$/.test(call.name)) return false;
  return receiver !== undefined && fn.params.some((parameter) =>
    parameter.name === receiver && parameter.sqlDatabase);
}

function requestPathTo(target: FunctionFact, edges: CallEdge[]): CallEdge[] {
  const result: CallEdge[] = [];
  const pending = [target.id];
  const seen = new Set(pending);
  while (pending.length > 0) {
    const id = pending.shift()!;
    for (const edge of edges.filter((candidate) => candidate.callee.id === id)) {
      result.push(edge);
      if (!seen.has(edge.caller.id)) {
        seen.add(edge.caller.id);
        pending.push(edge.caller.id);
      }
    }
  }
  return result;
}

function receiverCacheIsProvenRequestLocal(
  fn: FunctionFact,
  cacheId: string,
  requestPath: CallEdge[],
): boolean {
  if (!cacheId.startsWith("field:") || fn.receiverName === undefined || fn.receiverType === undefined) return false;
  const receiverType = fn.receiverType;
  const incoming = requestPath.filter((edge) => edge.callee.id === fn.id);
  if (incoming.length === 0) return false;
  return incoming.every((edge) => {
    const receiver = edge.call.functionText.match(/^([A-Za-z_]\w*)\.[A-Za-z_]\w*$/)?.[1];
    if (receiver === undefined) return false;
    const ancestors = scopeAncestors(edge.caller.scopes, edge.scopeId);
    const assignments = edge.caller.assignments.filter((assignment) =>
      assignment.start < edge.start && edge.start <= assignment.visibilityEnd && assignment.targets.includes(receiver) &&
      (ancestors.includes(assignment.scopeId) || (!assignment.declaration &&
        callableScope(edge.caller.scopes, assignment.scopeId) === callableScope(edge.caller.scopes, edge.scopeId))));
    const latest = assignments.at(-1);
    if (latest === undefined || !latest.declaration) return false;
    const index = latest.targets.indexOf(receiver);
    const value = latest.expressions[index] ?? (index === 0 ? latest.expressions[0] : undefined);
    if (value === undefined) return false;
    const compact = value.replace(/\s+/g, "");
    const type = escapeRegExp(receiverType);
    return new RegExp(`^(?:&?${type}\\{|new\\(${type}\\))`).test(compact);
  });
}

function hasFiniteAdmission(
  scopes: Array<{ fn: FunctionFact; beforePosition: number; seeds: Map<string, Dependencies> }>,
  keyOrigins: Set<string>,
  byName: Map<string, FunctionFact>,
  summaries: Map<string, Dependencies>,
): boolean {
  return scopes.some(({ fn, beforePosition, seeds }) => {
    const sourceCode = fn.source.slice(0, Math.max(0, beforePosition - fn.start));
    const source = maskGoNonCode(sourceCode);
    for (const admission of fn.admissions.filter((fact) => fact.start < beforePosition)) {
      const relativeStart = admission.start - fn.start;
      if (!isDirectGuardForEndpoint(source, relativeStart)) continue;
      const environment = environmentAt(fn, admission.start, admission.scopeId, seeds, byName, summaries);
      if (sameRequestOrigin(expressionDependencies(admission.key, environment, byName, summaries), keyOrigins)) return true;
    }
    return false;
  });
}

function scopeForPosition(scopes: Map<string, LexicalScope>, position: number): LexicalScope {
  return [...scopes.values()].filter((scope) => position >= scope.start && position <= scope.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0] ?? [...scopes.values()][0]!;
}

function hasHardCacheBound(
  fn: FunctionFact,
  insertion: CacheAccess,
  material: Call,
  finiteConstants: Set<string>,
  shadowedBuiltins: Set<string>,
  caches: Map<string, PersistentCache>,
  functions: FunctionFact[],
): boolean {
  if (shadowedBuiltins.has(`${fn.scope}:len`)) return false;
  const before = maskGoNonCode(fn.source.slice(0, Math.max(0, material.start - fn.start)));
  for (const guard of fn.capacityGuards.filter((fact) => fact.start < material.start)) {
    const provenFinite = isPositiveGoInteger(guard.bound) || finiteConstants.has(`${fn.scope}:${guard.bound}`);
    const relativeStart = guard.start - fn.start;
    if (provenFinite && !guard.boundLocallyShadowed && isDirectGuardForEndpoint(before, relativeStart) &&
      resolveCacheAt(fn, guard.cache, guard.start, guard.scopeId, caches) === insertion.cacheId &&
      capacityGuardRemainsValid(fn, guard, insertion, material, caches, functions)) {
      return true;
    }
  }
  return false;
}

function capacityGuardRemainsValid(
  fn: FunctionFact,
  guard: CapacityGuardFact,
  insertion: CacheAccess,
  material: Call,
  caches: Map<string, PersistentCache>,
  functions: FunctionFact[],
): boolean {
  if (guard.kind === "return") return true;
  const cacheId = insertion.cacheId;
  if (cacheId === undefined) return false;
  if (fn.accesses.some((access) => access.kind === "insert" && access.start > guard.start &&
    access.start < insertion.start && resolveCacheAt(fn, access.cacheText, access.start, access.scopeId, caches) === cacheId)) {
    return false;
  }
  return !fn.calls.some((call) => call.start > guard.end && call.start < insertion.start && call.start !== material.start &&
    callMayMutateCache(fn, call, cacheId, caches, functions));
}

function callMayMutateCache(
  fn: FunctionFact,
  call: Call,
  cacheId: string,
  caches: Map<string, PersistentCache>,
  functions: FunctionFact[],
  seen = new Set<string>(),
): boolean {
  const expressions = [...call.args];
  const receiver = call.functionText.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\./)?.[1];
  if (receiver !== undefined) expressions.push(receiver);
  if (expressions.some((expression) => (maskGoNonCode(expression).match(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?/g) ?? [])
    .some((candidate) => resolveCacheAt(fn, candidate, call.start, call.scopeId, caches) === cacheId))) return true;
  if (call.args.length !== 0 || call.functionText !== call.name) return false;
  const candidates = functions.filter((candidate) => candidate.scope === fn.scope && candidate.name === call.name);
  if (candidates.length !== 1 || seen.has(candidates[0]!.id)) return false;
  const callee = candidates[0]!;
  const nextSeen = new Set(seen).add(callee.id);
  if (callee.accesses.some((access) => access.kind === "insert" &&
    resolveCacheAt(callee, access.cacheText, access.start, access.scopeId, caches) === cacheId)) return true;
  return callee.calls.some((nested) => callMayMutateCache(callee, nested, cacheId, caches, functions, nextSeen));
}

function hasSharedLinearScan(functions: FunctionFact[], cacheId: string): boolean {
  const cacheName = cacheId.startsWith("global:")
    ? cacheId.split(":").at(-1)!
    : cacheId.split(".").at(-1)!;
  const cache = escapeRegExp(cacheName);
  return functions.some((fn) =>
    new RegExp(`\\.(?:Lock|RLock)\\s*\\(\\)[\\s\\S]{0,500}?for\\s+[^\\n{]*range\\s+(?:[A-Za-z_]\\w*\\.)?${cache}\\b`).test(maskGoNonCode(fn.source)));
}

function parseOuterCall(expression: string): { name: string; args: string[] } | undefined {
  const match = expression.trim().match(/^(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
  return match === null ? undefined : { name: match[1]!, args: splitTopLevel(match[2]!) };
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted !== "") {
      if (character === "\\") index += 1;
      else if (character === quoted) quoted = "";
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quoted = character;
    else if ("([{<".includes(character)) depth += 1;
    else if (")]}>".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail !== "") parts.push(tail);
  return parts;
}

function changedLineInRange(
  files: SourceRevision[],
  path: string,
  startLine: number,
  endLine: number,
): number | undefined {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) return undefined;
  if (file.status === "repository" || file.status === "added") return startLine;
  for (let line = startLine; line <= endLine; line += 1) {
    if (!file.changedLines.has(line)) continue;
    if (file.deletionAnchors?.has(line)) return line;
    if (file.previous === undefined) return line;
    const currentLine = (maskGoNonCode(file.current, false).split("\n")[line - 1] ?? "").trimEnd();
    const previousLine = (maskGoNonCode(file.previous, false).split("\n")[line - 1] ?? "").trimEnd();
    if (previousLine !== currentLine) return line;
  }
  return undefined;
}

function lineAt(source: string, line: number): string {
  return source.split("\n")[line - 1] ?? "";
}

function union(...sets: Dependencies[]): Dependencies {
  return new Set(sets.flatMap((set) => [...set]));
}

function sameDependencies(left: Dependencies, right: Dependencies): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deduplicate(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${String(signal.data.cacheDeclaration)}:${String(signal.data.insertion)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function importAliases(source: string, root: Node, module: string, defaultAlias: string): Set<string> {
  const aliases = new Set<string>();
  for (const spec of descendants(root, "import_spec")) {
    const text = sourceText(spec, source).trim();
    const match = text.match(new RegExp(`^(?:(\\.|[A-Za-z_]\\w*)\\s+)?"${escapeRegExp(module)}"$`));
    if (match !== null) aliases.add(match[1] ?? defaultAlias);
  }
  return aliases;
}

function isSqlDatabaseType(type: string, aliases: Set<string>): boolean {
  const normalized = type.replace(/^\*/, "").replace(/\s+/g, "");
  const match = normalized.match(/^([A-Za-z_]\w*)\.(?:DB|Tx)$/);
  return match !== null && aliases.has(match[1]!);
}

function isHttpRequestType(type: string, aliases: Set<string>): boolean {
  const normalized = type.replace(/^\*/, "").replace(/\s+/g, "");
  if (normalized === "Request") return aliases.has(".");
  const match = normalized.match(/^([A-Za-z_]\w*)\.Request$/);
  return match !== null && aliases.has(match[1]!);
}

function packageScope(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

function collectFiniteConstants(file: SourceRevision, root: Node, constants: Set<string>, scope: string): void {
  for (const declaration of descendants(root, "const_declaration")) {
    if (declaration.parent?.type !== "source_file") continue;
    for (const spec of descendants(declaration, "const_spec")) {
      const text = sourceText(spec, file.current);
      const match = text.match(/^\s*([A-Za-z_]\w*)(?:\s+[A-Za-z_]\w*)?\s*=\s*([0-9][0-9A-Fa-f_xXoObB]*)\s*$/);
      if (match !== null && isPositiveGoInteger(match[2]!)) constants.add(`${scope}:${match[1]}`);
    }
  }
}

function isPositiveGoInteger(value: string): boolean {
  try {
    return BigInt(value.replace(/_/g, "")) > 0n;
  } catch {
    return false;
  }
}

function isDirectGuardForEndpoint(source: string, index: number): boolean {
  if (index < 0) return false;
  return braceDepth(source.slice(0, index)) === braceDepth(source);
}

function braceDepth(source: string): number {
  let depth = 0;
  for (const character of source) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
  }
  return depth;
}

function maskGoNonCode(source: string, maskStrings = true): string {
  const output = [...source];
  let state: "code" | "double" | "single" | "raw" | "line" | "block" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1] ?? "";
    if (state === "code") {
      if (character === '"') state = "double";
      else if (character === "'") state = "single";
      else if (character === "`") state = "raw";
      else if (character === "/" && next === "/") state = "line";
      else if (character === "/" && next === "*") state = "block";
      else continue;
    } else if (state === "double" || state === "single") {
      if (character === "\\") {
        if (maskStrings) output[index] = " ";
        index += 1;
        if (maskStrings && index < output.length && source[index] !== "\n") output[index] = " ";
        continue;
      }
      const closing = state === "double" ? '"' : "'";
      if (maskStrings) output[index] = character === "\n" ? "\n" : " ";
      if (character === closing) state = "code";
      continue;
    } else if (state === "raw") {
      if (maskStrings) output[index] = character === "\n" ? "\n" : " ";
      if (character === "`") state = "code";
      continue;
    } else if (state === "line") {
      if (character === "\n") {
        state = "code";
        continue;
      }
    } else if (state === "block" && character === "*" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 1;
      state = "code";
      continue;
    }
    if (character !== "\n" && (maskStrings || state === "line" || state === "block")) output[index] = " ";
  }
  return output.join("");
}
