import { dirname } from "node:path";
import { descendants, parseGo, sourceText } from "./parser.js";
import { type Signal, type SourceRevision } from "./types.js";
import { type Node } from "web-tree-sitter";

const RULE_ID = "go-perf.environment-process-inspection-per-request";
const PROCESS_INSPECTION = /^(?:GetContainerIDByProcess|GetContainerIDForPID|GetPodUIDAndContainerID|ContainerIDByProcess|ReadProcessCgroup|ReadCgroup|ProcessCgroup)$/;
const RESOLVER_METHOD = /^(?:Get|Resolve|Lookup).*(?:PodUID|ContainerID|ProcessIdentity|WorkloadID)$/;
const HOT_METHOD = /^(?:ServeHTTP|Handle|Preprocess|Invoke|Intercept|Process|Fetch\w*|Stream\w*)$/;

interface CallFact {
  receiver: string;
  member: string;
  args: string[];
  line: number;
  endLine: number;
  start: number;
  text: string;
  executable: boolean;
  topLevelNilGate: boolean;
}

interface FunctionFact {
  file: SourceRevision;
  packageKey: string;
  name: string;
  receiverName?: string;
  receiverType?: string;
  params: Map<string, string>;
  text: string;
  start: number;
  end: number;
  line: number;
  endLine: number;
  calls: CallFact[];
  identifiers: Set<string>;
  constructedTypes: Set<string>;
}

interface ProgramFacts {
  functions: FunctionFact[];
  imports: Map<string, Map<string, string>>;
  fields: Map<string, string>;
}

interface RawFinding {
  fingerprint: string;
  hot: FunctionFact;
  helper: FunctionFact;
  implementation: FunctionFact;
  constructor: FunctionFact;
  wiring: FunctionFact;
  resolverCall: CallFact;
  inspectionCall: CallFact;
}

export async function environmentProcessInspectionSignals(files: SourceRevision[]): Promise<Signal[]> {
  const current = await rawFindings(files);
  const previousFiles = previousRevisions(files);
  const comparePrevious = files.some((file) => file.status === "modified" && file.previous !== undefined);
  const previous = !comparePrevious || previousFiles.length === 0 ? [] : await rawFindings(previousFiles);
  const previousFingerprints = new Set(previous.map((finding) => finding.fingerprint));

  return current.flatMap((finding): Signal[] => {
    if (previousFingerprints.has(finding.fingerprint)) return [];
    const anchor = changedAnchor(files, finding);
    if (anchor === undefined) return [];
    return [{
      ruleId: RULE_ID,
      path: anchor.path,
      line: anchor.line,
      ...(anchor.endLine === anchor.line ? {} : { endLine: anchor.endLine }),
      message:
        `${finding.hot.name} reaches ${finding.inspectionCall.member} for each request through ` +
        `${finding.resolverCall.member}, without a construction-time environment gate or bounded process-ID cache.`,
      snippet: anchor.snippet,
      data: {
        hotPath: finding.hot.name,
        resolverMethod: finding.resolverCall.member,
        inspectionOperation: finding.inspectionCall.member,
        constructor: finding.constructor.name,
        semanticFingerprint: finding.fingerprint,
      },
    }];
  });
}

async function rawFindings(files: SourceRevision[]): Promise<RawFinding[]> {
  const goFiles = files.filter((file) =>
    file.path.endsWith(".go") &&
    !file.path.endsWith("_test.go") &&
    !/(?:^|\/)(?:vendor|testdata|generated)(?:\/|$)/.test(file.path));
  const program = await collectProgram(goFiles);
  const findings: RawFinding[] = [];

  for (const implementation of program.functions) {
    if (implementation.receiverType === undefined || !RESOLVER_METHOD.test(implementation.name)) continue;
    const pid = [...implementation.params].find(([, type]) => /^(?:u?int(?:32|64)?|pid_t)$/.test(compact(type)));
    if (pid === undefined) continue;
    const inspectionCall = implementation.calls.find((call) =>
      call.executable &&
      PROCESS_INSPECTION.test(call.member) &&
      expressionUsesName(call.args.join(","), pid[0]) &&
      receiverStartsWith(call.receiver, implementation.receiverName) &&
      bindingUnshadowed(implementation, implementation.receiverName, call.start));
    if (inspectionCall === undefined) continue;
    if (!inspectionReceiverIsProcessField(implementation, inspectionCall, program)) continue;
    if (hasBoundedProcessCache(implementation, inspectionCall, pid[0])) continue;

    const constructors = program.functions.filter((candidate) =>
      candidate.receiverType === undefined &&
      /^(?:new|build|make).*(?:resolver|identity)/i.test(candidate.name) &&
      candidate.constructedTypes.has(implementation.receiverType!));
    for (const constructor of constructors) {
      if (hasEnvironmentGate(constructor, program.imports.get(constructor.file.path), implementation.receiverType)) continue;
      if (returnsCachedResolver(constructor, implementation, program.functions)) continue;

      for (const helper of program.functions) {
        if (helper.packageKey !== implementation.packageKey || helper.receiverType === undefined) continue;
        const resolverCall = helper.calls.find((call) =>
          call.executable && call.member === implementation.name &&
          call.args.length > 0 &&
          /(?:^|\.)(?:PID|Pid|ProcessID)$/.test(compact(call.args[0] ?? "")) &&
          receiverStartsWith(call.receiver, helper.receiverName) &&
          bindingUnshadowed(helper, helper.receiverName, call.start));
        if (resolverCall === undefined) continue;

        const hot = hotCallerOf(helper, program.functions, program.imports);
        if (hot === undefined) continue;
        const wiring = program.functions.find((candidate) =>
          candidate.packageKey === helper.packageKey &&
          candidate.constructedTypes.has(helper.receiverType!) &&
          candidate.calls.some((call) =>
            call.executable &&
            call.receiver === "" &&
            call.member === constructor.name &&
            bindingUnshadowed(candidate, constructor.name, call.start)));
        if (wiring === undefined) continue;
        const fingerprint = [
          helper.packageKey,
          hot.receiverType ?? "",
          hot.name,
          helper.name,
          implementation.receiverType,
          implementation.name,
          inspectionCall.member,
          constructor.name,
          wiring.name,
        ].join("|");
        findings.push({
          fingerprint,
          hot,
          helper,
          implementation,
          constructor,
          wiring,
          resolverCall,
          inspectionCall,
        });
      }
    }
  }
  return deduplicate(findings);
}

async function collectProgram(files: SourceRevision[]): Promise<ProgramFacts> {
  const functions: FunctionFact[] = [];
  const imports = new Map<string, Map<string, string>>();
  const fields = new Map<string, string>();
  for (const file of files) {
    const tree = await parseGo(file.current);
    try {
      if (tree.rootNode.hasError) throw new Error(`Go source contains syntax errors: ${file.path}`);
      const packageNode = tree.rootNode.namedChildren.find((node) => node.type === "package_clause");
      const packageName = packageNode === undefined
        ? ""
        : sourceText(packageNode, file.current).replace(/^package\s+/, "").trim();
      const packageKey = `${dirname(file.path)}:${packageName}`;
      imports.set(file.path, importAliases(tree.rootNode, file.current));
      for (const typeSpec of descendants(tree.rootNode, "type_spec")) {
        const typeNameNode = typeSpec.childForFieldName("name");
        const typeNode = typeSpec.childForFieldName("type");
        if (typeNameNode === null || typeNode?.type !== "struct_type") continue;
        const typeName = sourceText(typeNameNode, file.current);
        for (const field of descendants(typeNode, "field_declaration")) {
          const fieldTypeNode = field.childForFieldName("type");
          const fieldNameNode = field.childForFieldName("name");
          if (fieldTypeNode === null || fieldNameNode === null) continue;
          fields.set(
            `${packageKey}|${typeName}|${sourceText(fieldNameNode, file.current)}`,
            compact(sourceText(fieldTypeNode, file.current)),
          );
        }
      }
      for (const node of [
        ...descendants(tree.rootNode, "function_declaration"),
        ...descendants(tree.rootNode, "method_declaration"),
      ]) {
        const nameNode = node.childForFieldName("name");
        const body = node.childForFieldName("body");
        if (nameNode === null || body === null) continue;
        const receiver = node.childForFieldName("receiver");
        const receiverInfo = receiver === null ? {} : receiverBinding(receiver, file.current);
        const params = parameterBindings(node.childForFieldName("parameters"), file.current);
        const calls = descendants(body, "call_expression").flatMap((call): CallFact[] => {
          if (!directlyOwned(call, body)) return [];
          const fn = call.childForFieldName("function");
          const args = call.childForFieldName("arguments");
          if (fn === null || args === null) return [];
          let receiver = "";
          let member = "";
          if (fn.type === "selector_expression") {
            const operand = fn.childForFieldName("operand");
            const field = fn.childForFieldName("field");
            if (operand === null || field === null) return [];
            receiver = sourceText(operand, file.current);
            member = sourceText(field, file.current);
          } else if (fn.type === "identifier") {
            member = sourceText(fn, file.current);
          } else {
            return [];
          }
          return [{
            receiver,
            member,
            args: args.namedChildren.map((arg) => sourceText(arg, file.current)),
            line: call.startPosition.row + 1,
            endLine: call.endPosition.row + 1,
            start: call.startIndex,
            text: sourceText(call, file.current),
            executable: !staticallyDead(call, file.current),
            topLevelNilGate: topLevelNilGate(call, file.current),
          }];
        });
        functions.push({
          file,
          packageKey,
          name: sourceText(nameNode, file.current),
          ...receiverInfo,
          params,
          text: sourceText(node, file.current),
          start: node.startIndex,
          end: node.endIndex,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          calls,
          identifiers: new Set([
            ...descendants(body, "identifier"),
            ...descendants(body, "field_identifier"),
          ].filter((identifier) => directlyOwned(identifier, body)).map((identifier) => sourceText(identifier, file.current))),
          constructedTypes: new Set(descendants(body, "composite_literal").flatMap((literal): string[] => {
            if (!directlyOwned(literal, body)) return [];
            const type = literal.childForFieldName("type");
            if (type === null) return [];
            return [compact(sourceText(type, file.current)).replace(/^\*/, "")];
          })),
        });
      }
    } finally {
      tree.delete();
    }
  }
  return { functions, imports, fields };
}

function hotCallerOf(
  helper: FunctionFact,
  functions: FunctionFact[],
  imports: Map<string, Map<string, string>>,
): FunctionFact | undefined {
  if (isHotEntry(helper, imports.get(helper.file.path))) return helper;
  return functions.find((candidate) =>
    candidate.packageKey === helper.packageKey &&
    candidate.receiverType === helper.receiverType &&
    isHotEntry(candidate, imports.get(candidate.file.path)) &&
    candidate.calls.some((call) =>
      call.executable && call.member === helper.name &&
      compact(call.receiver) === compact(candidate.receiverName ?? "") &&
      bindingUnshadowed(candidate, candidate.receiverName, call.start)));
}

function hasEnvironmentGate(
  fn: FunctionFact,
  imports: Map<string, string> | undefined,
  implementationType: string,
): boolean {
  const osAliases = new Set(
    [...(imports ?? new Map())].filter(([, path]) => path === "os").map(([alias]) => alias),
  );
  const environmentCalls = fn.calls.filter((call) =>
    call.executable && osAliases.has(compact(call.receiver)) &&
    /^(?:Getenv|LookupEnv)$/.test(call.member) &&
    call.args.some((arg) => /(?:KUBERNETES|K8S|CONTAINER|CLOUD|PLATFORM|ENVIRONMENT)/i.test(arg)) &&
    call.topLevelNilGate &&
    bindingUnshadowed(fn, compact(call.receiver), call.start) &&
    call.start < firstTypeConstruction(fn, implementationType));
  return environmentCalls.length > 0;
}

function returnsCachedResolver(
  constructor: FunctionFact,
  implementation: FunctionFact,
  functions: FunctionFact[],
): boolean {
  return functions.some((wrapper) => {
    if (wrapper.packageKey !== implementation.packageKey || wrapper.name !== implementation.name) return false;
    if (wrapper.receiverType === implementation.receiverType || wrapper.receiverType === undefined) return false;
    if (!constructor.constructedTypes.has(wrapper.receiverType)) return false;
    const pid = [...wrapper.params].find(([, type]) => /^(?:u?int(?:32|64)?|pid_t)$/.test(compact(type)));
    if (pid === undefined) return false;
    const delegate = wrapper.calls.find((call) => call.member === implementation.name);
    return delegate !== undefined &&
      delegate.args.some((arg) => expressionUsesName(arg, pid[0])) &&
      hasBoundedProcessCache(wrapper, delegate, pid[0]);
  });
}

function hasBoundedProcessCache(fn: FunctionFact, work: CallFact, pidName: string): boolean {
  const read = fn.calls.find((call) =>
    call.executable &&
    /^(?:Load|Get|Lookup)$/.test(call.member) &&
    call.args.some((arg) => expressionUsesName(arg, pidName)) &&
    call.start < work.start);
  const write = fn.calls.find((call) =>
    call.executable &&
    /^(?:Store|Set|Add)$/.test(call.member) &&
    call.args.some((arg) => expressionUsesName(arg, pidName)) &&
    call.start > work.start);
  if (read === undefined || write === undefined) return false;
  const bounded = [...fn.identifiers].some((identifier) => /^(?:ttl|expiresAt|expiration|expires)$/i.test(identifier));
  const hitReturnBeforeWork = /\breturn\b/.test(fn.file.current.slice(read.start, work.start));
  return bounded && hitReturnBeforeWork;
}

function isHotEntry(fn: FunctionFact, imports: Map<string, string> | undefined): boolean {
  if (!HOT_METHOD.test(fn.name)) return false;
  const aliases = imports ?? new Map<string, string>();
  const contextAliases = new Set([...aliases].filter(([, path]) => path === "context").map(([alias]) => alias));
  const httpAliases = new Set([...aliases].filter(([, path]) => path === "net/http").map(([alias]) => alias));
  const types = [...fn.params.values()].map(compact);
  if (fn.name === "ServeHTTP") {
    return types.some((type) => [...httpAliases].some((alias) => type === `${alias}.ResponseWriter`)) &&
      types.some((type) => [...httpAliases].some((alias) => type === `*${alias}.Request`));
  }
  return types.some((type) => [...contextAliases].some((alias) => type === `${alias}.Context`));
}

function inspectionReceiverIsProcessField(
  fn: FunctionFact,
  call: CallFact,
  program: ProgramFacts,
): boolean {
  if (fn.receiverName === undefined || fn.receiverType === undefined) return false;
  const match = compact(call.receiver).match(new RegExp(`^${escapeRegExp(fn.receiverName)}\\.([A-Za-z_]\\w*)$`));
  const fieldName = match?.[1];
  if (fieldName === undefined) return false;
  const fieldType = program.fields.get(`${fn.packageKey}|${fn.receiverType}|${fieldName}`);
  if (fieldType === undefined) return false;
  const alias = fieldType.match(/^([A-Za-z_]\w*)\./)?.[1];
  if (alias === undefined) return false;
  const path = program.imports.get(fn.file.path)?.get(alias);
  return path !== undefined && /(?:^|\/)(?:containerinfo|container|procfs|cgroup)(?:\/|$)/i.test(path);
}

function changedAnchor(files: SourceRevision[], finding: RawFinding): {
  path: string;
  line: number;
  endLine: number;
  snippet: string;
} | undefined {
  const repositoryMode = files.every((file) => file.status === "repository");
  const candidates = [
    { file: finding.helper.file, line: finding.resolverCall.line, endLine: finding.resolverCall.endLine, text: finding.resolverCall.text },
    { file: finding.implementation.file, line: finding.inspectionCall.line, endLine: finding.inspectionCall.endLine, text: finding.inspectionCall.text },
    { file: finding.constructor.file, line: finding.constructor.line, endLine: finding.constructor.endLine, text: firstLine(finding.constructor.text) },
    { file: finding.wiring.file, line: finding.wiring.line, endLine: finding.wiring.endLine, text: firstLine(finding.wiring.text) },
    { file: finding.hot.file, line: finding.hot.line, endLine: finding.hot.endLine, text: firstLine(finding.hot.text) },
  ];
  for (const candidate of candidates) {
    const revision = files.find((file) => file.path === candidate.file.path);
    if (revision === undefined) continue;
    if ((repositoryMode && revision.status === "repository") || revision.status === "added") {
      return { path: revision.path, line: candidate.line, endLine: candidate.endLine, snippet: candidate.text.trim().slice(0, 300) };
    }
    for (let line = candidate.line; line <= candidate.endLine; line += 1) {
      if (revision.changedLines.has(line)) {
        return { path: revision.path, line, endLine: line, snippet: candidate.text.trim().slice(0, 300) };
      }
    }
  }
  for (const file of files) {
    if (file.status !== "modified" || file.deletionAnchors === undefined) continue;
    const line = [...file.deletionAnchors].sort((left, right) => left - right)[0];
    if (line !== undefined && [finding.constructor.file.path, finding.implementation.file.path, finding.helper.file.path, finding.wiring.file.path].includes(file.path)) {
      return { path: file.path, line, endLine: line, snippet: lineText(file.current, line) };
    }
  }
  return undefined;
}

function previousRevisions(files: SourceRevision[]): SourceRevision[] {
  return files.flatMap((file): SourceRevision[] => {
    if (file.status === "added") return [];
    const { previous, deletionAnchors: _deletionAnchors, ...revision } = file;
    if (file.status === "modified") {
      if (previous === undefined) return [];
      return [{ ...revision, current: previous, status: "repository", changedLines: new Set() }];
    }
    return [{ ...revision, status: "repository", changedLines: new Set() }];
  });
}

function importAliases(root: Node, source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const spec of descendants(root, "import_spec")) {
    const pathNode = spec.childForFieldName("path");
    if (pathNode === null) continue;
    const path = sourceText(pathNode, source).replace(/^"|"$/g, "");
    const nameNode = spec.childForFieldName("name");
    const alias = nameNode === null ? (path.split("/").pop() ?? "") : sourceText(nameNode, source);
    if (alias !== "_" && alias !== ".") aliases.set(alias, path);
  }
  return aliases;
}

function receiverBinding(node: Node, source: string): { receiverName?: string; receiverType?: string } {
  const text = sourceText(node, source).replace(/^\(|\)$/g, "").trim();
  const match = text.match(/^([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*)$/);
  const receiverName = match?.[1];
  const receiverType = match?.[2];
  return receiverName === undefined || receiverType === undefined ? {} : { receiverName, receiverType };
}

function parameterBindings(node: Node | null, source: string): Map<string, string> {
  const result = new Map<string, string>();
  if (node === null) return result;
  for (const declaration of descendants(node, "parameter_declaration")) {
    const typeNode = declaration.childForFieldName("type");
    if (typeNode === null) continue;
    const type = sourceText(typeNode, source);
    for (const nameNode of declaration.namedChildren.filter((child) => child.type === "identifier")) {
      result.set(sourceText(nameNode, source), type);
    }
  }
  return result;
}

function staticallyDead(node: Node, source: string): boolean {
  let current: Node | null = node;
  while (current?.parent !== null && current?.parent !== undefined) {
    const parent: Node = current.parent;
    if (parent.type === "statement_list") {
      const statement = parent.namedChildren.find((child) => contains(child, node));
      if (statement !== undefined) {
        const index = parent.namedChildren.indexOf(statement);
        if (parent.namedChildren.slice(0, index).some((sibling) => sibling.type === "return_statement")) {
          return true;
        }
      }
    }
    if (parent.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      const consequence = parent.childForFieldName("consequence");
      const alternative = parent.childForFieldName("alternative");
      const value = condition === null ? "" : compact(sourceText(condition, source));
      if (value === "false" && consequence !== null && contains(consequence, node)) return true;
      if (value === "true" && alternative !== null && contains(alternative, node)) return true;
    }
    current = parent;
    if (parent.type === "function_declaration" || parent.type === "method_declaration") break;
  }
  return false;
}

function directlyOwned(node: Node, body: Node): boolean {
  let current: Node | null = node;
  while (current !== null && current.id !== body.id) {
    if (current.type === "func_literal") return false;
    current = current.parent;
  }
  return current !== null;
}

function topLevelNilGate(node: Node, source: string): boolean {
  let current: Node | null = node;
  while (current?.parent !== null && current?.parent !== undefined) {
    const parent: Node = current.parent;
    if (parent.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      const consequence = parent.childForFieldName("consequence");
      const initializer = parent.childForFieldName("initializer");
      if (condition === null || consequence === null) return false;
      const conditionText = compact(sourceText(condition, source));
      const callText = compact(sourceText(node, source));
      const directGetenv = contains(condition, node) &&
        (conditionText === `${callText}==""` || conditionText === `""==${callText}`);
      const lookupInitializer = initializer !== null && contains(initializer, node)
        ? compact(sourceText(initializer, source)).match(/^(?:[A-Za-z_]\w*|_),([A-Za-z_]\w*):=(.+)$/)
        : null;
      const lookupEnv = lookupInitializer !== null &&
        lookupInitializer[2]?.includes(callText) === true &&
        conditionText === `!${lookupInitializer[1]}`;
      if (!directGetenv && !lookupEnv) return false;
      if (!/\breturn\s+nil\b/.test(sourceText(consequence, source))) return false;
      const statements = parent.parent;
      const block = statements?.type === "statement_list" ? statements.parent : statements;
      return block?.type === "block" &&
        (block.parent?.type === "function_declaration" || block.parent?.type === "method_declaration");
    }
    current = parent;
    if (parent.type === "function_declaration" || parent.type === "method_declaration") break;
  }
  return false;
}

function contains(outer: Node, inner: Node): boolean {
  return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;
}

function receiverStartsWith(receiver: string, name: string | undefined): boolean {
  if (name === undefined) return false;
  const value = compact(receiver);
  return value === name || value.startsWith(`${name}.`);
}

function bindingUnshadowed(fn: FunctionFact, name: string | undefined, before: number): boolean {
  if (name === undefined) return false;
  if (fn.params.has(name)) return false;
  const prefix = fn.file.current.slice(fn.start, before);
  return !new RegExp(`(?:^|[;{}\\n])\\s*(?:var\\s+${escapeRegExp(name)}\\b|${escapeRegExp(name)}\\s*:=)`).test(prefix);
}

function deduplicate(findings: RawFinding[]): RawFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.fingerprint)) return false;
    seen.add(finding.fingerprint);
    return true;
  });
}

function expressionUsesName(expression: string, name: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(name)}(?:[^A-Za-z0-9_]|$)`).test(expression);
}

function firstTypeConstruction(fn: FunctionFact, type: string): number {
  const match = new RegExp(`(?:&\\s*)?${escapeRegExp(type)}\\s*\\{`).exec(fn.file.current.slice(fn.start, fn.end));
  return match?.index === undefined ? Number.POSITIVE_INFINITY : fn.start + match.index;
}

function compact(value: string): string {
  return value.replace(/\s+/g, "").replace(/^\((.*)\)$/s, "$1");
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim().slice(0, 300) ?? "";
}

function lineText(source: string, line: number): string {
  return source.split("\n")[line - 1]?.trim().slice(0, 300) ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
