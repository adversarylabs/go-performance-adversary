import { type Node } from "web-tree-sitter";
import { descendants, sourceText } from "./parser.js";
import { type Signal, type SourceRevision } from "./types.js";

const RULE_ID = "go-perf.string-concat-loop";
const SMALL_FIXED_BOUND = 32;

export function stringConcatLoopSignals(file: SourceRevision, root: Node): Signal[] {
  const signals: Signal[] = [];

  for (const assignment of descendants(root, "assignment_statement")) {
    const loop = nearestAncestor(assignment, "for_statement");
    if (loop === null || !sameNode(nearestCallable(assignment), nearestCallable(loop))) continue;
    if (isProvablySmallFixedLoop(loop, file.current)) continue;

    const left = singleExpression(assignment.childForFieldName("left"));
    const right = singleExpression(assignment.childForFieldName("right"));
    if (left?.type !== "identifier" || right === null) continue;

    const name = sourceText(left, file.current);
    const operator = assignmentOperator(assignment, file.current);
    const declaration = resolveDeclaration(root, left, name, file.current);
    if (declaration === null || declaration.node.startIndex >= loop.startIndex) continue;

    const selfReferential = operator === "=" && growsFromSameValue(right, name, file.current);
    const compound = operator === "+=";
    if (!compound && !selfReferential) continue;
    if (!declaration.isString && !expressionProvesString(right, file.current)) continue;
    if (hasPerIterationReset(loop, assignment, name, file.current)) continue;

    signals.push({
      ruleId: RULE_ID,
      path: file.path,
      line: assignment.startPosition.row + 1,
      ...(assignment.endPosition.row === assignment.startPosition.row
        ? {}
        : { endLine: assignment.endPosition.row + 1 }),
      message: `String accumulator ${name} grows across iterations and reallocates on every update.`,
      snippet: sourceText(assignment, file.current).trim().slice(0, 300),
      data: {
        accumulator: name,
        operator,
        loopLine: loop.startPosition.row + 1,
        declarationLine: declaration.node.startPosition.row + 1,
        semanticKey: semanticKey(assignment, loop, declaration.node, name, operator, file.current),
      },
    });
  }

  return signals;
}

function semanticKey(
  assignment: Node,
  loop: Node,
  declaration: Node,
  name: string,
  operator: string,
  source: string,
): string {
  const callable = nearestCallable(assignment);
  const callableName = callable?.childForFieldName("name");
  const receiver = callable?.childForFieldName("receiver");
  const control = loop.namedChildren.find((child) => child.type !== "block");
  return [
    callable?.type ?? "package",
    callableName === null || callableName === undefined ? "" : semanticText(callableName, source),
    receiver === null || receiver === undefined ? "" : semanticText(receiver, source),
    name,
    operator,
    semanticText(declaration, source),
    control === undefined ? "for{}" : semanticText(control, source),
    semanticText(assignment, source),
  ].join("|");
}

function semanticText(node: Node, source: string): string {
  if (node.type === "comment") return "";
  if (node.childCount === 0) return sourceText(node, source).replace(/\s+/g, "");
  return node.children
    .filter((child) => child.type !== "comment")
    .map((child) => semanticText(child, source))
    .join("");
}

interface Declaration {
  node: Node;
  isString: boolean;
}

function resolveDeclaration(root: Node, use: Node, name: string, source: string): Declaration | null {
  const candidates: Declaration[] = [];
  const callable = nearestCallable(use);

  for (const node of descendants(root, "var_spec")) {
    if (node.startIndex >= use.startIndex || !visibleFromCallable(node, callable)) continue;
    const names = declarationNames(node.childForFieldName("name"), source);
    const index = names.indexOf(name);
    if (index < 0 || !scopeContains(node, use)) continue;
    const type = node.childForFieldName("type");
    const value = expressionAt(node.childForFieldName("value"), index);
    candidates.push({
      node,
      isString: type !== null
        ? sourceText(type, source).replace(/\s+/g, "") === "string"
        : value !== null && expressionProvesString(value, source),
    });
  }

  for (const node of descendants(root, "parameter_declaration")) {
    if (node.startIndex >= use.startIndex || !visibleFromCallable(node, callable)) continue;
    if (!declarationNames(node.childForFieldName("name"), source).includes(name)) continue;
    if (!scopeContains(node, use)) continue;
    const type = node.childForFieldName("type");
    candidates.push({
      node,
      isString: type !== null && sourceText(type, source).replace(/\s+/g, "") === "string",
    });
  }

  for (const node of descendants(root, "short_var_declaration")) {
    if (node.startIndex >= use.startIndex || !visibleFromCallable(node, callable)) continue;
    const names = declarationNames(node.childForFieldName("left"), source);
    const index = names.indexOf(name);
    if (index < 0 || !scopeContains(node, use)) continue;
    const value = expressionAt(node.childForFieldName("right"), index);
    candidates.push({ node, isString: value !== null && expressionProvesString(value, source) });
  }

  // Range variables are declared for the loop and are reset on every iteration.
  for (const node of descendants(root, "range_clause")) {
    if (node.startIndex >= use.startIndex || !visibleFromCallable(node, callable)) continue;
    if (!sourceText(node, source).includes(":=")) continue;
    if (!declarationNames(node.childForFieldName("left"), source).includes(name)) continue;
    if (scopeContains(node, use)) candidates.push({ node, isString: false });
  }

  candidates.sort((left, right) => right.node.startIndex - left.node.startIndex);
  return candidates[0] ?? null;
}

function declarationNames(node: Node | null, source: string): string[] {
  if (node === null) return [];
  if (node.type === "identifier") return [sourceText(node, source)];
  return node.namedChildren
    .filter((child) => child.type === "identifier")
    .map((child) => sourceText(child, source));
}

function expressionAt(node: Node | null, index: number): Node | null {
  if (node === null) return null;
  if (node.type !== "expression_list") return index === 0 ? node : null;
  return node.namedChild(index);
}

function singleExpression(node: Node | null): Node | null {
  if (node === null) return null;
  if (node.type === "expression_list") {
    return node.namedChildCount === 1 ? node.namedChild(0) : null;
  }
  return node;
}

function assignmentOperator(node: Node, source: string): string {
  const operator = node.children.find((child) => !child.isNamed && /^(?:\+=|=)$/.test(sourceText(child, source)));
  return operator === undefined ? "" : sourceText(operator, source);
}

function growsFromSameValue(expression: Node, name: string, source: string): boolean {
  const unwrapped = unwrapParentheses(expression);
  if (unwrapped.type !== "binary_expression") return false;
  const operator = unwrapped.children.find((child) => !child.isNamed)?.type;
  if (operator !== "+") return false;
  const left = unwrapped.childForFieldName("left");
  return left !== null && leftmostOperand(left, source) === name;
}

function leftmostOperand(node: Node, source: string): string {
  let current = unwrapParentheses(node);
  while (current.type === "binary_expression") {
    const left = current.childForFieldName("left");
    if (left === null) break;
    current = unwrapParentheses(left);
  }
  return current.type === "identifier" ? sourceText(current, source) : "";
}

function expressionProvesString(expression: Node, source: string): boolean {
  const unwrapped = unwrapParentheses(expression);
  if (unwrapped.type === "interpreted_string_literal" || unwrapped.type === "raw_string_literal") return true;
  if (descendants(unwrapped, "interpreted_string_literal").length > 0) return true;
  if (descendants(unwrapped, "raw_string_literal").length > 0) return true;
  if (unwrapped.type === "call_expression") {
    const fn = unwrapped.childForFieldName("function");
    return fn !== null && sourceText(fn, source).replace(/\s+/g, "") === "string";
  }
  return false;
}

function hasPerIterationReset(loop: Node, assignment: Node, name: string, source: string): boolean {
  let current: Node = assignment;
  while (current.startIndex >= loop.startIndex && current.endIndex <= loop.endIndex) {
    const statements = nearestAncestor(current, "statement_list");
    if (statements === null || statements.startIndex < loop.startIndex) return false;
    const candidateStatement = directChildContaining(statements, current);
    if (candidateStatement === null) return false;

    const siblings = statements.namedChildren;
    const index = siblings.findIndex((statement) => sameNode(statement, candidateStatement));
    if (index < 0) return false;
    for (let candidate = 0; candidate < index; candidate += 1) {
      if (directlyResets(siblings[candidate]!, name, source)) return true;
    }
    // A reset immediately after the update also prevents the value from
    // surviving into the next iteration. Limit this to a direct assignment;
    // a containing if/switch may bypass the following statement.
    if (sameNode(candidateStatement, assignment) && index + 1 < siblings.length &&
        directlyResets(siblings[index + 1]!, name, source)) return true;

    const parent = statements.parent;
    if (parent === null || sameNode(parent, loop.childForFieldName("body"))) return false;
    current = parent;
  }
  return false;
}

function directlyResets(statement: Node, name: string, source: string): boolean {
  if (statement.type === "short_var_declaration") {
    return declarationNames(statement.childForFieldName("left"), source).includes(name);
  }
  if (statement.type === "var_declaration") {
    return descendants(statement, "var_spec").some((spec) =>
      declarationNames(spec.childForFieldName("name"), source).includes(name));
  }
  if (statement.type !== "assignment_statement") return false;
  const left = singleExpression(statement.childForFieldName("left"));
  const right = singleExpression(statement.childForFieldName("right"));
  if (left?.type !== "identifier" || sourceText(left, source) !== name || right === null) return false;
  const operator = assignmentOperator(statement, source);
  return operator === "=" && !growsFromSameValue(right, name, source);
}

function directChildContaining(parent: Node, descendant: Node): Node | null {
  return parent.namedChildren.find((child) =>
    child.startIndex <= descendant.startIndex && child.endIndex >= descendant.endIndex) ?? null;
}

function isProvablySmallFixedLoop(loop: Node, source: string): boolean {
  const control = loop.namedChildren.find((child) => child.type !== "block");
  if (control === undefined) return false;

  if (control.type === "range_clause") {
    const right = control.childForFieldName("right");
    if (right === null) return false;
    if (right.type === "int_literal") return smallInteger(sourceText(right, source));
    if (right.type === "composite_literal") {
      const value = right.childForFieldName("body");
      return value !== null && value.namedChildCount <= SMALL_FIXED_BOUND;
    }
    return false;
  }

  if (control.type !== "for_clause") return false;
  const initializer = control.childForFieldName("initializer");
  const condition = control.childForFieldName("condition");
  const update = control.childForFieldName("update");
  if (initializer?.type !== "short_var_declaration" || condition?.type !== "binary_expression" || update === null) {
    return false;
  }
  const left = singleExpression(initializer.childForFieldName("left"));
  const initial = singleExpression(initializer.childForFieldName("right"));
  const conditionLeft = condition.childForFieldName("left");
  const conditionRight = condition.childForFieldName("right");
  if (left?.type !== "identifier" || initial?.type !== "int_literal" || conditionLeft?.type !== "identifier" ||
      conditionRight?.type !== "int_literal") return false;
  const variable = sourceText(left, source);
  if (sourceText(conditionLeft, source) !== variable) return false;
  const initialValue = Number(sourceText(initial, source).replaceAll("_", ""));
  const boundValue = Number(sourceText(conditionRight, source).replaceAll("_", ""));
  if (!Number.isInteger(initialValue) || !Number.isInteger(boundValue)) return false;
  const conditionOperator = condition.children.find((child) => !child.isNamed)?.type;
  const updateText = sourceText(update, source).replace(/\s+/g, "");
  const step = updateText === `${variable}++`
    ? 1
    : updateText === `${variable}--`
      ? -1
      : signedUpdateStep(updateText, variable);
  if (step === 0) return false;

  let iterations: number;
  if ((conditionOperator === "<" || conditionOperator === "<=") && step > 0) {
    const distance = boundValue - initialValue + (conditionOperator === "<=" ? 1 : 0);
    iterations = distance <= 0 ? 0 : Math.ceil(distance / step);
  } else if ((conditionOperator === ">" || conditionOperator === ">=") && step < 0) {
    const distance = initialValue - boundValue + (conditionOperator === ">=" ? 1 : 0);
    iterations = distance <= 0 ? 0 : Math.ceil(distance / Math.abs(step));
  } else {
    return false;
  }
  return iterations <= SMALL_FIXED_BOUND;
}

function signedUpdateStep(text: string, variable: string): number {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^${escaped}([+-])=(\\d[\\d_]*)$`));
  if (match?.[1] === undefined || match[2] === undefined) return 0;
  const magnitude = Number(match[2].replaceAll("_", ""));
  if (!Number.isInteger(magnitude) || magnitude <= 0) return 0;
  return match[1] === "+" ? magnitude : -magnitude;
}

function smallInteger(text: string): boolean {
  const value = Number(text.replaceAll("_", ""));
  return Number.isInteger(value) && value >= 0 && value <= SMALL_FIXED_BOUND;
}

function scopeContains(declaration: Node, use: Node): boolean {
  const scope = lexicalScope(declaration);
  return scope !== null && scope.startIndex <= use.startIndex && scope.endIndex >= use.endIndex;
}

function lexicalScope(node: Node): Node | null {
  let current: Node | null = node.parent;
  while (current !== null) {
    if (current.type === "block" || current.type === "source_file" || current.type === "function_declaration" ||
        current.type === "method_declaration" || current.type === "func_literal" || current.type === "for_statement") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function nearestCallable(node: Node): Node | null {
  let current: Node | null = node.parent;
  while (current !== null) {
    if (current.type === "function_declaration" || current.type === "method_declaration" || current.type === "func_literal") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function visibleFromCallable(declaration: Node, useCallable: Node | null): boolean {
  const declarationCallable = nearestCallable(declaration);
  if (declarationCallable !== null) return sameNode(declarationCallable, useCallable);
  return lexicalScope(declaration)?.type === "source_file";
}

function sameNode(left: Node | null, right: Node | null): boolean {
  if (left === null || right === null) return left === right;
  return left.type === right.type && left.startIndex === right.startIndex && left.endIndex === right.endIndex;
}

function nearestAncestor(node: Node, type: string): Node | null {
  let current: Node | null = node.parent;
  while (current !== null) {
    if (current.type === type) return current;
    current = current.parent;
  }
  return null;
}

function unwrapParentheses(node: Node): Node {
  let current = node;
  while (current.type === "parenthesized_expression" && current.namedChildCount === 1) {
    const child = current.namedChild(0);
    if (child === null) break;
    current = child;
  }
  return current;
}
