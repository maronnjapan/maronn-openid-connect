/**
 * Small helpers over the syntax tree of `typescript/unstable/ast`: the kinds
 * the analysis walks, the lines of a node, and the expression under the
 * wrappers that do not change what runs (parentheses, `await`, `as`, `!`).
 */
import { SyntaxKind, type Node, type SourceFile } from './ts.js';

/** A node of any kind with the children the analysis reads; the syntax tree's own types are narrower than the walk needs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNode = Node & Record<string, any>;

/** Whether a node is of a kind. */
export function is(node: Node | undefined, kind: SyntaxKind): node is AnyNode {
  return node !== undefined && node.kind === kind;
}

/** The node as one with any children (after a kind check). */
export function any(node: Node): AnyNode {
  return node as AnyNode;
}

/** The 1-based line of an offset of a file. */
export function lineAt(file: SourceFile, offset: number): number {
  return file.getLineAndCharacterOfPosition(offset).line + 1;
}

/** The first line of a node's own text (its leading comments left out). */
export function startLine(file: SourceFile, node: Node): number {
  return lineAt(file, node.getStart(file));
}

/** The last line of a node. */
export function endLine(file: SourceFile, node: Node): number {
  return lineAt(file, Math.max(node.getStart(file), node.end - 1));
}

/** The text of a node. */
export function textOf(file: SourceFile, node: Node): string {
  return file.text.slice(node.getStart(file), node.end);
}

/** A text between the children of a node (punctuation, keywords and trivia only) without its comments. */
function withoutComments(text: string): string {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * The text of a node without the comments in it: a comment is not code, so a
 * comment added inside a statement does not change what the statement is.
 * The comments sit between the children of the nodes (the strings, templates
 * and regular expressions are children of their own), so they are taken out
 * of the text between the children only.
 */
export function codeText(file: SourceFile, node: Node): string {
  const start = node.getStart(file);
  const kids = children(node);
  if (kids.length === 0) return file.text.slice(start, node.end);
  let text = '';
  let at = start;
  for (const child of kids) {
    const childStart = child.getStart(file);
    if (childStart < at) continue;
    text += withoutComments(file.text.slice(at, childStart));
    text += codeText(file, child);
    at = child.end;
  }
  return text + withoutComments(file.text.slice(at, node.end));
}

/** The kinds that only wrap an expression: what runs is the expression inside. */
const WRAPPERS = new Set<SyntaxKind>([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AwaitExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.TypeAssertionExpression,
]);

/** The expression under parentheses, `await`, `as`, `!` and `satisfies`. */
export function unwrap(node: Node): Node {
  let current = node;
  while (WRAPPERS.has(current.kind)) current = any(current)['expression'] as Node;
  return current;
}

/** The kinds of function-like nodes (a body of their own: what is in it does not run where it is written). */
export const FUNCTION_LIKE = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
]);

/** Whether a node is function-like (see FUNCTION_LIKE). */
export function isFunctionLike(node: Node): boolean {
  return FUNCTION_LIKE.has(node.kind);
}

/** The children of a node, in order. */
export function children(node: Node): Node[] {
  const list: Node[] = [];
  node.forEachChild((child) => {
    list.push(child);
    return undefined;
  });
  return list;
}

/** Visit a node and its descendants, depth first; `visit` returns false to skip the children of a node. */
export function walk(node: Node, visit: (node: Node) => boolean | void): void {
  if (visit(node) === false) return;
  node.forEachChild((child) => {
    walk(child, visit);
    return undefined;
  });
}

/** The string of a string literal or a template without substitutions; undefined for any other node. */
export function stringOf(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral) return any(node)['text'] as string;
  return undefined;
}

/** The name of a named node (an identifier, a string or a private name), or undefined. */
export function nameOf(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.PrivateIdentifier) return any(node)['text'] as string;
  return stringOf(node);
}
