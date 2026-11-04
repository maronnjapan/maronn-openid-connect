/**
 * The flow tree of a frame (a function, or the handler of an endpoint): its
 * body read with the compiler as the nested statements it is, not as boxes
 * and arrows.
 *
 * Every statement is one node at its place in its list, so the id of a node
 * is its position (`s3`, `s3t0`, ...) and the lines of the nodes of a list
 * cover the lines of the list with no gap (the comments and blank lines above
 * a statement are its own). A changed line is always in some node.
 *
 * - A statement that calls a function of the catalog or a member of an
 *   interface is a call node; the other calls it makes first are its `pre`.
 * - A statement that calls none is an action.
 * - `if`, `switch`, loops and `try` keep their sides as branches. `&&` and
 *   `||` inside the condition of an `if` stay in its code.
 * - In any other expression, `?:`, `??`, `||`, `&&` and the logical
 *   assignments with a call in an arm are cond-expr nodes, and a callback a
 *   call runs (`items.map((x) => f(x))`) is a loop.
 * - A marker (`// [step-id] (feature: id) Label — Spec`) opens a block: the
 *   statements of its list up to the next marker, or up to a statement that
 *   holds markers of its own.
 *
 * The words of a node come from the code (words.ts), replaced by the comment
 * above the statement or the JSDoc of what it calls when there is one.
 */
import type { Branch, CallTarget, FlowTree, StepMark, TreeNode } from './model.js';
import { SyntaxKind, getLeadingCommentRanges, type Node, type SourceFile } from './ts.js';
import { any, codeText, endLine, is, isFunctionLike, lineAt, nameOf, startLine, stringOf, textOf, unwrap, walk } from './ast.js';
import type { FileResolution } from './resolve.js';
import { SIDE_WORDS, actionWords, bindingNames, conditionWords, errorWords, predicateWords, shorten } from './words.js';

/** A marker line: `// [id] (feature: f) Label — Spec`. */
const MARKER = /^\/\/ \[([a-z0-9-]+)\](?: \(feature: ([a-z0-9-]+)\))? (.*)$/;
const MARKER_IN_TEXT = /^[ \t]*\/\/ \[[a-z0-9-]+\](?: \(feature: [a-z0-9-]+\))? /m;

/** The methods whose callback runs once an element. */
const ITERATION = new Set(['map', 'forEach', 'filter', 'flatMap', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'reduce', 'reduceRight', 'sort', 'toSorted']);

export interface TreeContext {
  file: SourceFile;
  resolution: FileResolution;
  /** What a target does: the first paragraph of the JSDoc of the function or the member. */
  summaryOf(target: CallTarget): string | undefined;
  /** The step a function is (a step of Hono is a function of its own). */
  stepOf(functionId: string): StepMark | undefined;
  /** Join the lines of a comment into a paragraph (packages/cli prose.ts). */
  joinLines(lines: string[]): string;
}

export interface FrameInput {
  id: string;
  name: string;
  signature: string;
  /** The source of the file, `core:client-auth.ts`. */
  file: string;
  /** The function-like node (a function declaration, an arrow function, a function expression). */
  declaration: Node;
  /** The first line of the frame: its JSDoc, else its declaration. */
  firstLine: number;
  /** The last line of the frame (the end of the statement that registers a handler, for one). */
  lastLine?: number;
}

/** A decision that tests a value a block produces: the side where the value is there, and the side where it is not. */
export interface ValueUse {
  decision: TreeNode;
  /** The name of the value. */
  name: string;
  present: string;
  absent: string;
}

/** The tree, with what the selections and the diff are computed from. */
export interface BuiltTree {
  tree: FlowTree;
  /** Each block → the decisions that test the values it produces. */
  uses: Map<TreeNode, ValueUse[]>;
  /**
   * The code of each node's own part, on one line, in full: the statement of
   * a call or an action, the condition of an `if`, the header of a loop. The
   * diff compares these (the code of a node is shortened for the page).
   */
  own: Map<TreeNode, string>;
}

type Mode = 'value' | 'condition';

/** The text of a comment without its markers, on lines. */
function commentLines(text: string): string[] {
  if (text.startsWith('//')) return [text.slice(2).trim()];
  return text
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim());
}

/** Whether a comment is a directive for a tool (eslint, TypeScript), not words for a reader. */
function isDirective(lines: readonly string[]): boolean {
  return /^(eslint-|@ts-|prettier-ignore|istanbul |c8 )/.test(lines.join(' ').trim());
}

/** Whether a list ends the frame whatever its decisions choose. */
export function ends(nodes: readonly TreeNode[]): boolean {
  return nodes.some(endsNode);
}

/** Whether a node ends the frame whatever its decisions choose. */
function endsNode(node: TreeNode): boolean {
  switch (node.kind) {
    case 'return':
      return node.local !== true;
    case 'throw':
      return true;
    case 'if':
      return (node.branches ?? []).length === 2 && (node.branches ?? []).every((branch) => ends(branch.nodes));
    case 'switch': {
      const branches = node.branches ?? [];
      if (!branches.some((branch) => branch.key === 'default' || branch.label === 'default')) return false;
      return branches.every((branch, index) => ends(branch.nodes) || (branch.fallsThrough === true && index < branches.length - 1));
    }
    case 'try': {
      const branches = node.branches ?? [];
      const attempt = branches.find((branch) => branch.key === 'try');
      const handler = branches.find((branch) => branch.key === 'catch');
      const final = branches.find((branch) => branch.key === 'finally');
      if (final !== undefined && ends(final.nodes)) return true;
      return attempt !== undefined && ends(attempt.nodes) && (handler === undefined || ends(handler.nodes));
    }
    case 'block':
      return ends(node.branches?.[0]?.nodes ?? []);
    default:
      return false;
  }
}

/** Whether a node or one below it is of a kind. */
export function holds(node: TreeNode, test: (node: TreeNode) => boolean): boolean {
  if (test(node)) return true;
  return (node.pre ?? []).some((child) => holds(child, test)) || (node.branches ?? []).some((branch) => branch.nodes.some((child) => holds(child, test)));
}

const DECISIONS = new Set(['if', 'switch', 'loop', 'try', 'cond-expr']);

/** The letters the ids of the nodes of a branch start with, after the id of the node. */
function branchPrefix(node: TreeNode, branch: Branch, index: number): string {
  switch (node.kind) {
    case 'if':
    case 'cond-expr':
      return { true: 't', false: 'e', nullish: 'n', defined: 'd' }[branch.key] ?? `b${index}`;
    case 'switch':
      return `c${index}s`;
    case 'loop':
      return 'l';
    case 'try':
      return { try: 'b', catch: 'h', finally: 'f' }[branch.key] ?? `b${index}`;
    default:
      return 's';
  }
}

/** Give every node its id from its position (see TreeNode). */
export function place(nodes: TreeNode[], prefix: string): void {
  nodes.forEach((node, index) => {
    node.id = `${prefix}${index}`;
    placeChildren(node);
  });
}

function placeChildren(node: TreeNode): void {
  if (node.pre !== undefined) place(node.pre, `${node.id}i`);
  node.branches?.forEach((branch, index) => place(branch.nodes, `${node.id}${branchPrefix(node, branch, index)}`));
}

/** Stretch a node, and the last node of its last list, down to a line. */
function extend(node: TreeNode, line: number): void {
  node.lines = [node.lines[0], line];
  if (node.kind !== 'block') return;
  const children = node.branches?.[0]?.nodes ?? [];
  const tail = children[children.length - 1];
  if (tail !== undefined) extend(tail, line);
}

/** Code on one line: whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

class Builder {
  readonly own = new Map<TreeNode, string>();
  readonly deferred = new Set<string>();
  readonly implementations: Array<{ member: string; lines: [number, number]; calls?: string[] }> = [];
  readonly uses = new Map<TreeNode, ValueUse[]>();
  /** A name → the block that declares it (and the feature of the block). */
  private readonly declaredBy = new Map<string, { block: TreeNode; feature?: string }>();
  private readonly blocks: TreeNode[] = [];
  private readonly catchNames: string[] = [];
  private callbackDepth = 0;
  /** The local functions being inlined (inline()), so one that calls itself stops. */
  private readonly inlining: Node[] = [];
  /** The expression a statement evaluates, while its nodes are built (a cond-expr that is the statement itself). */
  private statementLevel: Node | undefined;

  constructor(private readonly context: TreeContext) {}

  private get file(): SourceFile {
    return this.context.file;
  }

  private start(node: Node): number {
    return startLine(this.file, node);
  }

  private end(node: Node): number {
    return endLine(this.file, node);
  }

  private text(node: Node): string {
    return textOf(this.file, node);
  }

  /** The code of a node in full, on one line, without its comments: what the diff compares (BuiltTree.own). */
  private code(node: Node): string {
    return flat(codeText(this.file, node));
  }

  /** The header of a loop statement in full, without its comments: `for (const x of xs)`, `while (more)`. */
  private loopHead(statement: Node): string {
    const node = any(statement);
    const part = (key: string) => (node[key] === undefined ? '' : this.code(node[key] as Node));
    switch (statement.kind) {
      case SyntaxKind.ForStatement:
        return `for (${part('initializer')}; ${part('condition')}; ${part('incrementor')})`;
      case SyntaxKind.ForOfStatement:
        return `for ${node['awaitModifier'] === undefined ? '' : 'await '}(${part('initializer')} of ${part('expression')})`;
      case SyntaxKind.ForInStatement:
        return `for (${part('initializer')} in ${part('expression')})`;
      case SyntaxKind.DoStatement:
        return `do … while (${part('expression')})`;
      default:
        return `while (${part('expression')})`;
    }
  }

  // ---- the code of a node, on one line

  /** An expression as short code: calls with their arguments, object literals by their keys, the rest cut. */
  compact(node: Node | undefined, depth = 0): string {
    if (node === undefined) return '';
    const raw = this.text(node).replace(/\s+/g, ' ').trim();
    if (raw.length <= 40 && !raw.includes('=>') && !raw.includes('{')) return raw;
    switch (node.kind) {
      case SyntaxKind.CallExpression: {
        const callee = this.compact(any(node)['expression'] as Node, depth + 1);
        const args = (any(node)['arguments'] as Node[]).map((arg) => (depth > 1 ? '…' : this.compact(arg, depth + 1)));
        let joined = args.join(', ');
        if (joined.length > 40) joined = `${args.slice(0, 2).join(', ')}${args.length > 2 ? ', …' : ''}`;
        if (joined.length > 50) joined = '…';
        return `${callee}(${joined})`;
      }
      case SyntaxKind.NewExpression:
        return `new ${this.compact(any(node)['expression'] as Node, depth + 1)}(${(any(node)['arguments'] as Node[] | undefined)?.length ? '…' : ''})`;
      case SyntaxKind.AwaitExpression:
        return `await ${this.compact(any(node)['expression'] as Node, depth)}`;
      case SyntaxKind.ParenthesizedExpression:
        return `(${this.compact(any(node)['expression'] as Node, depth)})`;
      case SyntaxKind.AsExpression:
      case SyntaxKind.SatisfiesExpression:
      case SyntaxKind.NonNullExpression:
        return this.compact(any(node)['expression'] as Node, depth);
      case SyntaxKind.ObjectLiteralExpression: {
        const keys = (any(node)['properties'] as Node[]).map((property) => {
          if (is(property, SyntaxKind.SpreadAssignment)) return `...${this.compact(property['expression'] as Node, depth + 1)}`;
          return nameOf(any(property)['name']) ?? '…';
        });
        const shown = keys.slice(0, 4).join(', ');
        return keys.length === 0 ? '{}' : `{ ${shown}${keys.length > 4 ? ', …' : ''} }`;
      }
      case SyntaxKind.ArrayLiteralExpression:
        return (any(node)['elements'] as Node[]).length === 0 ? '[]' : '[…]';
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression:
        return '(…) => …';
      case SyntaxKind.PropertyAccessExpression:
        return `${this.compact(any(node)['expression'] as Node, depth)}${any(node)['questionDotToken'] ? '?.' : '.'}${nameOf(any(node)['name']) ?? ''}`;
      case SyntaxKind.BinaryExpression:
        return `${this.compact(any(node)['left'] as Node, depth + 1)} ${this.text(any(node)['operatorToken'] as Node)} ${this.compact(any(node)['right'] as Node, depth + 1)}`;
      case SyntaxKind.ConditionalExpression:
        return `${this.compact(any(node)['condition'] as Node, depth + 1)} ? ${this.compact(any(node)['whenTrue'] as Node, depth + 1)} : ${this.compact(any(node)['whenFalse'] as Node, depth + 1)}`;
      case SyntaxKind.PrefixUnaryExpression:
        return shorten(raw, 50);
      case SyntaxKind.TemplateExpression:
        return '`…`';
      default:
        return shorten(raw, 50);
    }
  }

  /** The code of a statement, on one line: a declaration with its value compacted. */
  private statementCode(statement: Node): string {
    if (is(statement, SyntaxKind.VariableStatement)) {
      const list = any(statement['declarationList']);
      const keyword = /^\s*(const|let|var|using)/.exec(this.text(list))?.[1] ?? 'const';
      const parts = (list['declarations'] as Node[]).map((declaration) => {
        const name = this.bindingCode(any(declaration)['name'] as Node);
        const initializer = any(declaration)['initializer'] as Node | undefined;
        return initializer === undefined ? name : `${name} = ${this.compact(initializer)}`;
      });
      return shorten(`${keyword} ${parts.join(', ')}`, 90);
    }
    if (is(statement, SyntaxKind.ExpressionStatement)) return shorten(this.compact(statement['expression'] as Node), 90);
    return shorten(this.text(statement), 90);
  }

  /** A binding name or pattern as code: `{ a, b, … }`. */
  private bindingCode(name: Node): string {
    if (is(name, SyntaxKind.Identifier)) return name['text'] as string;
    const names = bindingNames(this.text(name).replace(/\s+/g, ' '));
    const open = is(name, SyntaxKind.ArrayBindingPattern) ? '[' : '{';
    const close = open === '[' ? ']' : '}';
    return `${open} ${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''} ${close}`;
  }

  // ---- comments and markers

  /** The comments right above a statement: the marker among them, and the words of the others. */
  private comments(statement: Node): { marker?: StepMark; markerLine?: number; note?: string } {
    const ranges = getLeadingCommentRanges(this.file.text, statement.pos) ?? [];
    let marker: StepMark | undefined;
    let markerLine: number | undefined;
    let notes: string[][] = [];
    for (const range of ranges) {
      const text = this.file.text.slice(range.pos, range.end);
      const found = MARKER.exec(text.trim());
      if (found !== null) {
        const [label, spec] = (found[3] as string).split(/ — /, 2) as [string, string?];
        marker = { id: found[1] as string, label: label.trim(), ...(found[2] === undefined ? {} : { feature: found[2] }), ...(spec === undefined ? {} : { spec: spec.trim() }) };
        markerLine = lineAt(this.file, range.pos);
        // The words above a marker are about the block before it.
        notes = [];
        continue;
      }
      const lines = commentLines(text);
      if (isDirective(lines)) continue;
      notes.push(lines);
    }
    const words = notes.map((lines) => this.context.joinLines(lines.filter((line) => line !== ''))).filter((line) => line !== '');
    const note = words.length === 0 ? undefined : shorten(this.context.joinLines(words), 220);
    return { ...(marker === undefined ? {} : { marker, markerLine: markerLine as number }), ...(note === undefined ? {} : { note }) };
  }

  /** Whether a statement holds a marker below its first token (a `try` whose blocks are steps). */
  private holdsMarker(statement: Node): boolean {
    return MARKER_IN_TEXT.test(this.file.text.slice(statement.getStart(this.file), statement.end));
  }

  // ---- lists

  /**
   * The nodes of a list of statements whose lines are `from`..`to`: each
   * takes the lines from the one after the previous statement to its own
   * last line, so blank lines and comments go with the statement below them.
   */
  list(statements: readonly Node[], from: number, last?: number): TreeNode[] {
    type Entry = { statement: Node; note?: string };
    type Item = Entry | { block: StepMark; line: number; items: Entry[] };
    const items: Item[] = [];
    let open: { block: StepMark; line: number; items: Entry[] } | undefined;
    for (const statement of statements) {
      if (statement.kind === SyntaxKind.EmptyStatement) continue;
      const { marker, markerLine, note } = this.comments(statement);
      const inner = this.holdsMarker(statement);
      if (marker !== undefined) {
        open = { block: marker, line: markerLine ?? this.start(statement), items: [] };
        items.push(open);
      } else if (inner) {
        open = undefined;
      }
      const entry: Entry = note === undefined ? { statement } : { statement, note };
      if (open !== undefined) open.items.push(entry);
      else items.push(entry);
      if (inner && marker !== undefined) open = undefined;
    }
    const nodes: TreeNode[] = [];
    let previous = from - 1;
    for (const item of items) {
      if (!('block' in item)) {
        const node = this.statement(item.statement, item.note);
        if (node === undefined) continue;
        node.lines = [Math.min(previous + 1, this.start(item.statement)), this.end(item.statement)];
        nodes.push(node);
        previous = node.lines[1];
        continue;
      }
      const last = item.items[item.items.length - 1]?.statement;
      if (last === undefined) continue;
      const lastLine = this.end(last);
      const block: TreeNode = {
        id: '',
        kind: 'block',
        lines: [Math.min(previous + 1, item.line), lastLine],
        code: `[${item.block.id}]`,
        text: item.block.label,
        from: 'comment',
        step: item.block,
        ...(item.block.feature === undefined ? {} : { feature: item.block.feature }),
        branches: [],
      };
      this.blocks.push(block);
      const children: TreeNode[] = [];
      // The marker's line is the block's own; its statements share the lines below it.
      let inside = item.line;
      for (const entry of item.items) {
        const node = this.statement(entry.statement, entry.note);
        if (node === undefined) continue;
        node.lines = [Math.min(inside + 1, this.start(entry.statement)), this.end(entry.statement)];
        children.push(node);
        inside = node.lines[1];
        for (const name of this.declaredNames(entry.statement)) this.declaredBy.set(name, { block, ...(item.block.feature === undefined ? {} : { feature: item.block.feature }) });
      }
      this.blocks.pop();
      block.branches = [{ key: 'body', label: item.block.label, nodes: children }];
      nodes.push(block);
      previous = lastLine;
    }
    // The lines after the last statement (a trailing comment, blank lines) are the last node's.
    const tail = nodes[nodes.length - 1];
    if (tail !== undefined && last !== undefined && last > tail.lines[1]) extend(tail, last);
    return nodes;
  }

  /** The names a statement declares (`const { a, b } = ...` → a, b). */
  private declaredNames(statement: Node): string[] {
    if (!is(statement, SyntaxKind.VariableStatement)) return [];
    return (any(statement['declarationList'])['declarations'] as Node[]).flatMap((declaration) => {
      const name = any(declaration)['name'] as Node;
      return is(name, SyntaxKind.Identifier) ? [name['text'] as string] : bindingNames(this.text(name));
    });
  }

  /** The nodes of the side of an `if`, a loop or a label: a block's statements, or the one statement. */
  private side(statement: Node): TreeNode[] {
    if (is(statement, SyntaxKind.Block)) {
      return this.list(statement['statements'] as Node[], lineAt(this.file, statement.getStart(this.file)) + 1, this.end(statement) - 1);
    }
    return this.list([statement], this.start(statement));
  }

  // ---- statements

  private statement(statement: Node, note: string | undefined): TreeNode | undefined {
    const lines: [number, number] = [this.start(statement), this.end(statement)];
    const words = (node: TreeNode, fallback?: { text: string; from: 'doc' | 'code' }) => {
      if (note !== undefined) {
        node.text = note;
        node.from = 'comment';
      } else if (fallback !== undefined && fallback.text !== '') {
        node.text = fallback.text;
        node.from = fallback.from;
      }
      return node;
    };
    switch (statement.kind) {
      case SyntaxKind.ExpressionStatement:
      case SyntaxKind.VariableStatement: {
        const expressions = is(statement, SyntaxKind.ExpressionStatement)
          ? [statement['expression'] as Node]
          : (any(any(statement)['declarationList'])['declarations'] as Node[]).flatMap((declaration) => {
              const initializer = any(declaration)['initializer'] as Node | undefined;
              return initializer === undefined ? [] : [initializer];
            });
        const evaluated = expressions.flatMap((expression) => {
          this.statementLevel = unwrap(expression);
          const nodes = this.evaluate(expression, 'value');
          this.statementLevel = undefined;
          return nodes;
        });
        const code = this.statementCode(statement);
        if (evaluated.length === 0) {
          const action: TreeNode = { id: '', kind: 'action', lines, code };
          this.own.set(action, this.code(statement));
          return words(action, { text: actionWords(code), from: 'code' });
        }
        const node = evaluated.pop() as TreeNode;
        this.own.set(node, this.code(statement));
        const pre = [...evaluated, ...(node.pre ?? [])];
        if (pre.length > 0) node.pre = pre;
        else delete node.pre;
        node.code = code;
        node.lines = lines;
        if (note !== undefined) {
          node.text = note;
          node.from = 'comment';
        }
        return node;
      }
      case SyntaxKind.ReturnStatement: {
        const expression = any(statement)['expression'] as Node | undefined;
        const pre = expression === undefined ? [] : this.evaluate(expression, 'value');
        const node: TreeNode = { id: '', kind: 'return', lines, code: expression === undefined ? 'return' : shorten(`return ${this.compact(expression)}`, 80) };
        this.own.set(node, this.code(statement));
        if (pre.length > 0) node.pre = pre;
        if (this.callbackDepth > 0) node.local = true;
        return words(node);
      }
      case SyntaxKind.ThrowStatement: {
        const expression = any(statement)['expression'] as Node;
        const pre = this.evaluate(expression, 'value');
        const node: TreeNode = { id: '', kind: 'throw', lines, code: '', error: this.errorOf(expression) };
        node.code = `throw ${node.error}`;
        this.own.set(node, this.code(statement));
        const thrown = unwrap(expression);
        if (is(thrown, SyntaxKind.Identifier) && this.catchNames.includes(thrown['text'] as string)) node.rethrow = true;
        if (pre.length > 0) node.pre = pre;
        return words(node);
      }
      case SyntaxKind.IfStatement:
        return words(this.ifStatement(statement, lines), undefined);
      case SyntaxKind.SwitchStatement:
        return words(this.switchStatement(statement, lines));
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
        return words(this.loopStatement(statement, lines));
      case SyntaxKind.TryStatement:
        return words(this.tryStatement(statement, lines));
      case SyntaxKind.LabeledStatement: {
        const node = this.statement(any(statement)['statement'] as Node, note);
        if (node !== undefined) node.lines = lines;
        return node;
      }
      case SyntaxKind.Block: {
        const nodes = this.side(statement);
        const group: TreeNode = { id: '', kind: 'block', lines, code: '{ … }', branches: [{ key: 'body', label: '', nodes }] };
        this.own.set(group, '{ … }');
        return words(group);
      }
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.ClassDeclaration: {
        this.defer(statement);
        const name = nameOf(any(statement)['name']) ?? '';
        const keyword = statement.kind === SyntaxKind.ClassDeclaration ? 'class' : 'function';
        const definition: TreeNode = { id: '', kind: 'action', lines, code: `${keyword} ${name}`, text: `\`${name}\` を定義する`, from: 'code' };
        this.own.set(definition, this.code(statement));
        return words(definition);
      }
      default: {
        const code = shorten(this.text(statement), 90);
        const action: TreeNode = { id: '', kind: 'action', lines, code };
        this.own.set(action, this.code(statement));
        return words(action, { text: actionWords(code), from: 'code' });
      }
    }
  }

  /** The error a throw throws, in words: `TokenError(invalid_client)`, `Error`, `rethrow`. */
  private errorOf(expression: Node): string {
    const node = unwrap(expression);
    if (is(node, SyntaxKind.NewExpression)) {
      const name = this.text(node['expression'] as Node);
      const first = (node['arguments'] as Node[] | undefined)?.[0];
      const constant = first === undefined ? undefined : this.context.resolution.constants.get(first);
      if (constant !== undefined) return errorWords(name, constant);
      if (first !== undefined && is(first, SyntaxKind.PropertyAccessExpression)) return errorWords(name, nameOf(first['name']));
      const literal = stringOf(first);
      if (literal !== undefined && /^[a-z_]+$/.test(literal)) return errorWords(name, literal);
      return name;
    }
    if (is(node, SyntaxKind.CallExpression)) return `${this.text(node['expression'] as Node)}(…)`;
    if (is(node, SyntaxKind.Identifier)) return node['text'] as string;
    return shorten(this.text(node), 40);
  }

  /** The name a condition tests, and whether the true side is the one where it has a value. */
  private tested(condition: Node): { name: string; present: boolean } | undefined {
    const node = unwrap(condition);
    if (is(node, SyntaxKind.Identifier)) return { name: node['text'] as string, present: true };
    if (is(node, SyntaxKind.PrefixUnaryExpression) && node['operator'] === SyntaxKind.ExclamationToken) {
      const inner = this.tested(node['operand'] as Node);
      return inner === undefined ? undefined : { name: inner.name, present: !inner.present };
    }
    if (is(node, SyntaxKind.BinaryExpression)) {
      const operator = any(node['operatorToken'] as Node).kind;
      const left = unwrap(node['left'] as Node);
      const right = this.text(node['right'] as Node).trim();
      if (is(left, SyntaxKind.Identifier) && (right === 'undefined' || right === 'null')) {
        if (operator === SyntaxKind.ExclamationEqualsEqualsToken || operator === SyntaxKind.ExclamationEqualsToken) return { name: left['text'] as string, present: true };
        if (operator === SyntaxKind.EqualsEqualsEqualsToken || operator === SyntaxKind.EqualsEqualsToken) return { name: left['text'] as string, present: false };
      }
    }
    return undefined;
  }

  /** Note a decision that tests a value a block produces (see ValueUse), and narrow it for a block of a feature. */
  private noteUse(decision: TreeNode, name: string, present: string, absent: string): void {
    const producer = this.declaredBy.get(name);
    if (producer === undefined) return;
    const list = this.uses.get(producer.block) ?? [];
    list.push({ decision, name, present, absent });
    this.uses.set(producer.block, list);
    if (producer.feature !== undefined) decision.absent = { feature: producer.feature, side: absent };
  }

  private ifStatement(statement: Node, lines: [number, number]): TreeNode {
    const condition = any(statement)['expression'] as Node;
    const pre = this.evaluate(condition, 'condition');
    const yes = this.side(any(statement)['thenStatement'] as Node);
    const elseStatement = any(statement)['elseStatement'] as Node | undefined;
    const no = elseStatement === undefined ? [] : this.side(elseStatement);
    const subject = shorten(this.compact(condition), 70);
    const node: TreeNode = {
      id: '',
      kind: 'if',
      lines,
      code: shorten(`if (${subject})`, 80),
      subject,
      branches: [
        { key: 'true', label: SIDE_WORDS['true'] as string, nodes: yes },
        { key: 'false', label: SIDE_WORDS['false'] as string, nodes: no },
      ],
    };
    if (pre.length > 0) node.pre = pre;
    this.own.set(node, `if (${this.code(condition)})`);
    node.form = this.formOf(yes, no);
    // What it checks: the JSDoc of the predicate when the condition is that one call, else the words of the code.
    const predicate = this.predicateWords(condition, pre);
    const words = predicate ?? conditionWords(this.text(condition));
    if (words !== '') {
      node.text = words;
      node.from = predicate === undefined ? 'code' : 'doc';
    }
    const tested = this.tested(condition);
    if (tested !== undefined) this.noteUse(node, tested.name, tested.present ? 'true' : 'false', tested.present ? 'false' : 'true');
    return node;
  }

  /**
   * What a condition that is one call of a predicate (`isPublic(client)`,
   * `!(await isValid(x))`) checks, from the JSDoc of the predicate
   * (predicateWords); undefined for any other condition, whose words the
   * JSDoc of a call inside it does not say (`a && !isValid(x)`).
   */
  private predicateWords(condition: Node, pre: readonly TreeNode[]): string | undefined {
    let test = unwrap(condition);
    let negated = false;
    while (is(test, SyntaxKind.PrefixUnaryExpression) && test['operator'] === SyntaxKind.ExclamationToken) {
      negated = !negated;
      test = unwrap(test['operand'] as Node);
    }
    if (!is(test, SyntaxKind.CallExpression)) return undefined;
    const code = this.code(test);
    const call = pre.find((node) => node.kind === 'call' && node.from === 'doc' && node.text !== undefined && this.own.get(node) === code);
    if (call?.text === undefined) return undefined;
    const words = predicateWords(call.text, negated);
    return words === '' ? undefined : words;
  }

  /** guard, optional or fork (see TreeNode.form). */
  private formOf(yes: readonly TreeNode[], no: readonly TreeNode[]): TreeNode['form'] {
    if (no.length > 0) return 'fork';
    if (ends(yes) && yes.length <= 3 && !yes.some((node) => DECISIONS.has(node.kind))) return 'guard';
    if (!yes.some((node) => holds(node, (child) => child.kind === 'call' || DECISIONS.has(child.kind) || child.kind === 'return' || child.kind === 'throw'))) return 'optional';
    return 'fork';
  }

  /**
   * Where the sides of a cond-expr that is a statement of a block go: the
   * side that calls something leads into the block's step
   * (`refreshTokenRequest ?? validateAuthorizationCodeGrant(…)` in the block
   * of authorization_code).
   */
  private toward(node: TreeNode, statement: boolean): void {
    const block = this.blocks[this.blocks.length - 1];
    if (block?.step === undefined || !statement) return;
    const calling = (node.branches ?? []).filter((branch) => branch.nodes.some((child) => holds(child, (inner) => inner.kind === 'call')));
    if (calling.length === 1 && (node.branches ?? []).length === 2) (calling[0] as Branch).toward = `${block.step.label} へ`;
  }

  private switchStatement(statement: Node, lines: [number, number]): TreeNode {
    const expression = any(statement)['expression'] as Node;
    const pre = this.evaluate(expression, 'condition');
    const clauses = any(any(statement)['caseBlock'])['clauses'] as Node[];
    const branches: Branch[] = clauses.map((clause, index) => {
      const isDefault = clause.kind === SyntaxKind.DefaultClause;
      const statements = any(clause)['statements'] as Node[];
      const nodes = this.list(statements, this.start(clause) + 1, this.end(clause));
      const breaks = statements.length > 0 && is(statements[statements.length - 1], SyntaxKind.BreakStatement);
      const branch: Branch = {
        key: isDefault ? 'default' : `c${index}`,
        label: isDefault ? 'default' : shorten(`case ${this.compact(any(clause)['expression'] as Node)}`, 60),
        nodes,
      };
      if (!breaks && !ends(nodes) && index < clauses.length - 1) branch.fallsThrough = true;
      return branch;
    });
    if (!branches.some((branch) => branch.key === 'default')) branches.push({ key: 'default', label: SIDE_WORDS['default'] as string, nodes: [] });
    const subject = shorten(this.compact(expression), 60);
    const node: TreeNode = { id: '', kind: 'switch', lines, code: `switch (${subject})`, subject, branches };
    this.own.set(node, `switch (${this.code(expression)})`);
    if (pre.length > 0) node.pre = pre;
    return node;
  }

  private loopStatement(statement: Node, lines: [number, number]): TreeNode {
    const head: Node[] = [];
    let header: string;
    const node = any(statement);
    switch (statement.kind) {
      case SyntaxKind.ForStatement: {
        for (const part of ['initializer', 'condition', 'incrementor']) if (node[part] !== undefined) head.push(node[part] as Node);
        header = `for (${[node['initializer'], node['condition'], node['incrementor']].map((part) => (part === undefined ? '' : this.compact(part as Node))).join('; ')})`;
        break;
      }
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.ForInStatement: {
        head.push(node['expression'] as Node);
        const keyword = statement.kind === SyntaxKind.ForOfStatement ? 'of' : 'in';
        header = `for (${this.compact(node['initializer'] as Node)} ${keyword} ${this.compact(node['expression'] as Node)})`;
        break;
      }
      case SyntaxKind.DoStatement:
        head.push(node['expression'] as Node);
        header = `do … while (${this.compact(node['expression'] as Node)})`;
        break;
      default:
        head.push(node['expression'] as Node);
        header = `while (${this.compact(node['expression'] as Node)})`;
    }
    const pre = head.flatMap((part) => this.evaluate(part, 'condition'));
    const body = this.side(node['statement'] as Node);
    const branches: Branch[] = [{ key: 'body', label: SIDE_WORDS['body'] as string, nodes: body }];
    if (statement.kind !== SyntaxKind.DoStatement) branches.push({ key: 'skip', label: SIDE_WORDS['skip'] as string, nodes: [] });
    const loop: TreeNode = { id: '', kind: 'loop', lines, code: shorten(header, 80), subject: shorten(header, 60), branches };
    this.own.set(loop, this.loopHead(statement));
    if (pre.length > 0) loop.pre = pre;
    return loop;
  }

  private tryStatement(statement: Node, lines: [number, number]): TreeNode {
    const node = any(statement);
    const tryBlock = any(node['tryBlock']);
    const branches: Branch[] = [
      { key: 'try', label: SIDE_WORDS['try'] as string, nodes: this.list(tryBlock['statements'] as Node[], this.start(tryBlock) + 1, this.end(tryBlock) - 1) },
    ];
    const handler = node['catchClause'] as Node | undefined;
    if (handler !== undefined) {
      const variable = any(handler)['variableDeclaration'] as Node | undefined;
      const name = variable === undefined ? undefined : nameOf(any(variable)['name']);
      if (name !== undefined) this.catchNames.push(name);
      const block = any(any(handler)['block']);
      branches.push({ key: 'catch', label: SIDE_WORDS['catch'] as string, nodes: this.list(block['statements'] as Node[], this.start(handler) + 1, this.end(block) - 1) });
      if (name !== undefined) this.catchNames.pop();
    }
    const finallyBlock = node['finallyBlock'] as Node | undefined;
    if (finallyBlock !== undefined) {
      const block = any(finallyBlock);
      branches.push({ key: 'finally', label: SIDE_WORDS['finally'] as string, nodes: this.list(block['statements'] as Node[], this.start(block) + 1, this.end(block) - 1), always: true });
    }
    const tryNode: TreeNode = { id: '', kind: 'try', lines, code: handler === undefined ? 'try … finally' : 'try … catch', subject: '例外', branches };
    this.own.set(tryNode, tryNode.code);
    return tryNode;
  }

  // ---- expressions

  /** The nodes an expression evaluates, in order: calls, cond-exprs (in a value) and the callbacks a call runs. */
  evaluate(expression: Node, mode: Mode): TreeNode[] {
    const out: TreeNode[] = [];
    this.collect(expression, mode, out);
    return out;
  }

  private collect(node: Node, mode: Mode, out: TreeNode[]): void {
    switch (node.kind) {
      case SyntaxKind.CallExpression:
        return this.call(node, mode, out);
      case SyntaxKind.NewExpression: {
        this.collect(any(node)['expression'] as Node, mode, out);
        for (const argument of (any(node)['arguments'] as Node[] | undefined) ?? []) {
          const inner = unwrap(argument);
          if (is(inner, SyntaxKind.ArrowFunction) || is(inner, SyntaxKind.FunctionExpression)) {
            const loop = this.callback(node, inner);
            if (loop !== undefined) out.push(loop);
          } else this.collect(argument, mode, out);
        }
        return;
      }
      case SyntaxKind.ConditionalExpression: {
        const test = this.evaluate(any(node)['condition'] as Node, 'condition');
        const yes = this.evaluate(any(node)['whenTrue'] as Node, mode);
        const no = this.evaluate(any(node)['whenFalse'] as Node, mode);
        if (mode === 'condition' || (yes.length === 0 && no.length === 0)) {
          out.push(...test, ...yes, ...no);
          return;
        }
        out.push(this.condExpr(node, '?:', any(node)['condition'] as Node, test, [
          { key: 'true', label: SIDE_WORDS['true'] as string, nodes: yes },
          { key: 'false', label: SIDE_WORDS['false'] as string, nodes: no },
        ]));
        return;
      }
      case SyntaxKind.BinaryExpression: {
        const operator = any(any(node)['operatorToken'] as Node).kind;
        const left = any(node)['left'] as Node;
        const right = any(node)['right'] as Node;
        const logical = {
          [SyntaxKind.AmpersandAmpersandToken]: '&&',
          [SyntaxKind.BarBarToken]: '||',
          [SyntaxKind.QuestionQuestionToken]: '??',
          [SyntaxKind.AmpersandAmpersandEqualsToken]: '&&=',
          [SyntaxKind.BarBarEqualsToken]: '||=',
          [SyntaxKind.QuestionQuestionEqualsToken]: '??=',
        }[operator as number];
        if (logical === undefined) {
          this.collect(left, mode, out);
          this.collect(right, mode, out);
          return;
        }
        const before = this.evaluate(left, mode);
        const after = this.evaluate(right, mode);
        if (mode === 'condition' || after.length === 0) {
          out.push(...before, ...after);
          return;
        }
        const kind = logical.replace('=', '');
        const branches: Branch[] =
          kind === '??'
            ? [
                { key: 'defined', label: SIDE_WORDS['defined'] as string, nodes: [] },
                { key: 'nullish', label: SIDE_WORDS['nullish'] as string, nodes: after },
              ]
            : kind === '&&'
              ? [
                  { key: 'true', label: SIDE_WORDS['true'] as string, nodes: after },
                  { key: 'false', label: SIDE_WORDS['false'] as string, nodes: [] },
                ]
              : [
                  { key: 'true', label: SIDE_WORDS['true'] as string, nodes: [] },
                  { key: 'false', label: SIDE_WORDS['false'] as string, nodes: after },
                ];
        out.push(this.condExpr(node, logical, left, before, branches));
        return;
      }
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ClassExpression:
        this.defer(node);
        return;
      case SyntaxKind.ObjectLiteralExpression:
        for (const property of any(node)['properties'] as Node[]) {
          if (is(property, SyntaxKind.PropertyAssignment)) {
            const value = unwrap(property['initializer'] as Node);
            if (isFunctionLike(value)) this.implementation(property, value);
            else this.collect(property['initializer'] as Node, mode, out);
          } else if (is(property, SyntaxKind.SpreadAssignment)) {
            this.collect(property['expression'] as Node, mode, out);
          } else if (is(property, SyntaxKind.MethodDeclaration) || is(property, SyntaxKind.GetAccessor) || is(property, SyntaxKind.SetAccessor)) {
            this.implementation(property, property);
          }
        }
        return;
      default:
        node.forEachChild((child) => {
          this.collect(child, mode, out);
          return undefined;
        });
    }
  }

  /** A definition inside the frame: what it calls runs later, so it is deferred, not a node. */
  private defer(node: Node): void {
    walk(node, (inner) => {
      if (is(inner, SyntaxKind.CallExpression)) {
        const target = this.context.resolution.targets.get(inner);
        if (target !== undefined && target.kind !== 'untraceable') this.deferred.add(target.id);
      }
      return true;
    });
  }

  /** A property of an object literal that is a function: deferred, and an implementation when it implements a member, with what it calls. */
  private implementation(property: Node, value: Node): void {
    this.defer(value);
    const member = this.context.resolution.implementations.get(property);
    if (member === undefined) return;
    const calls = this.callsIn(value);
    this.implementations.push({ member, lines: [this.start(property), this.end(property)], ...(calls.length > 0 ? { calls } : {}) });
  }

  /**
   * The functions of the catalog and the members a definition calls, by id,
   * in the order of the code; a call of a function the frame defines itself
   * (`revokeConsentAndTokens(…)`) counts what that function calls.
   */
  private callsIn(definition: Node, seen: Set<Node> = new Set()): string[] {
    const calls: string[] = [];
    const add = (id: string) => {
      if (!calls.includes(id)) calls.push(id);
    };
    seen.add(definition);
    walk(definition, (inner) => {
      if (!is(inner, SyntaxKind.CallExpression)) return true;
      const target = this.context.resolution.targets.get(inner);
      if (target !== undefined && target.kind !== 'untraceable') add(target.id);
      const local = this.context.resolution.locals.get(inner);
      if (local !== undefined && !seen.has(local)) for (const id of this.callsIn(local, seen)) add(id);
      return true;
    });
    return calls;
  }

  private condExpr(node: Node, operator: string, test: Node, pre: TreeNode[], branches: Branch[]): TreeNode {
    const subject = shorten(this.compact(test), 60);
    const condition: TreeNode = { id: '', kind: 'cond-expr', lines: [this.start(node), this.end(node)], code: shorten(this.compact(node), 80), subject, operator, branches };
    this.own.set(condition, `${this.code(test)} ${operator}`);
    if (pre.length > 0) condition.pre = pre;
    const calls = branches.flatMap((branch) => branch.nodes).filter((child) => child.kind === 'call');
    const first = calls[0]?.code.replace(/\(.*$/, '()');
    const side = operator.startsWith('??') ? 'が無ければ' : operator.startsWith('&&') ? 'が真なら' : operator.startsWith('||') ? 'が偽なら' : 'で分けて';
    if (first !== undefined) {
      condition.text = operator === '?:' ? `${subject} で分けて呼ぶ` : `${subject} ${side} ${first} を呼ぶ`;
      condition.from = 'code';
    }
    const name = unwrap(test);
    if (is(name, SyntaxKind.Identifier)) {
      const present = operator.startsWith('??') ? 'defined' : 'true';
      const absent = operator.startsWith('??') ? 'nullish' : 'false';
      this.noteUse(condition, name['text'] as string, present, absent);
      const producer = this.declaredBy.get(name['text'] as string);
      const defined = branches.find((branch) => branch.key === present);
      if (producer?.block.step !== undefined && defined !== undefined && defined.nodes.length === 0) defined.toward = `${producer.block.step.label} の値を使う`;
    } else if (operator === '?:') {
      const tested = this.tested(test);
      if (tested !== undefined) this.noteUse(condition, tested.name, tested.present ? 'true' : 'false', tested.present ? 'false' : 'true');
    }
    this.toward(condition, this.statementLevel === node);
    return condition;
  }

  /** A call: what its callee and arguments evaluate, the callbacks it runs, then the call itself when it reaches the catalog or a member. */
  private call(node: Node, mode: Mode, out: TreeNode[]): void {
    const callee = any(node)['expression'] as Node;
    const inner = unwrap(callee);
    if (is(inner, SyntaxKind.PropertyAccessExpression)) this.collect(inner['expression'] as Node, mode, out);
    else if (is(inner, SyntaxKind.ElementAccessExpression)) {
      this.collect(inner['expression'] as Node, mode, out);
      this.collect(inner['argumentExpression'] as Node, mode, out);
    } else if (!is(inner, SyntaxKind.Identifier)) this.collect(callee, mode, out);
    const callbacks: Node[] = [];
    for (const argument of any(node)['arguments'] as Node[]) {
      const value = unwrap(argument);
      if (is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression)) callbacks.push(value);
      else this.collect(argument, mode, out);
    }
    for (const callback of callbacks) {
      const loop = this.callback(node, callback);
      if (loop !== undefined) out.push(loop);
    }
    const target = this.context.resolution.targets.get(node);
    if (target === undefined) {
      const local = this.context.resolution.locals.get(node);
      if (local !== undefined) {
        const inlined = this.inline(node, local);
        if (inlined !== undefined) out.push(inlined);
      }
      return;
    }
    const call: TreeNode = { id: '', kind: 'call', lines: [this.start(node), this.end(node)], code: shorten(this.compact(node), 80), target };
    this.own.set(call, this.code(node));
    const summary = this.context.summaryOf(target);
    if (summary !== undefined && summary !== '') {
      call.text = summary;
      call.from = 'doc';
    } else if (target.kind === 'untraceable') {
      call.text = target.why;
      call.from = 'code';
    }
    if (target.kind === 'function') {
      const step = this.context.stepOf(target.id);
      if (step !== undefined) call.step = step;
    }
    out.push(call);
  }

  /**
   * A call of a function the frame defines itself (`encode(header)` of
   * `const encode = (value) => ...`): what its body evaluates, run here, on
   * the lines of the call. Undefined when the body calls nothing of the
   * catalog and throws nothing, or for a function already being inlined.
   */
  private inline(call: Node, fn: Node): TreeNode | undefined {
    if (this.inlining.includes(fn)) return undefined;
    const body = any(fn)['body'] as Node | undefined;
    if (body === undefined) return undefined;
    this.inlining.push(fn);
    this.callbackDepth += 1;
    const nodes = is(body, SyntaxKind.Block) ? this.list(body['statements'] as Node[], this.start(body) + 1, this.end(body) - 1) : this.evaluate(body, 'value');
    this.callbackDepth -= 1;
    this.inlining.pop();
    if (!nodes.some((node) => holds(node, (child) => child.kind === 'call' || child.kind === 'throw'))) return undefined;
    const lines: [number, number] = [this.start(call), this.end(call)];
    for (const node of nodesOf(nodes)) node.lines = lines;
    const name = this.text(unwrap(any(call)['expression'] as Node));
    const loop: TreeNode = {
      id: '',
      kind: 'loop',
      lines,
      code: shorten(this.compact(call), 80),
      text: `\`${name}\` の中で`,
      from: 'code',
      branches: [{ key: 'body', label: `\`${name}\` の中で`, nodes }],
    };
    this.own.set(loop, this.code(call));
    return loop;
  }

  /** The callback a call runs, as a loop over its body; undefined when the body calls nothing of the catalog and throws nothing. */
  private callback(call: Node, fn: Node): TreeNode | undefined {
    const body = any(fn)['body'] as Node;
    this.callbackDepth += 1;
    const nodes = is(body, SyntaxKind.Block)
      ? this.list(body['statements'] as Node[], this.start(body) + 1, this.end(body) - 1)
      : this.evaluate(body, 'value');
    this.callbackDepth -= 1;
    if (!nodes.some((node) => holds(node, (child) => child.kind === 'call' || child.kind === 'throw'))) {
      this.defer(fn);
      return undefined;
    }
    const callee = unwrap(any(call)['expression'] as Node);
    const method = is(callee, SyntaxKind.PropertyAccessExpression) ? nameOf(callee['name']) : undefined;
    const iterates = method !== undefined && ITERATION.has(method);
    const head = shorten(`${this.compact(callee)}(…)`, 60);
    const loop: TreeNode = {
      id: '',
      kind: 'loop',
      lines: [this.start(call), this.end(call)],
      code: head,
      subject: head,
      text: iterates ? '各要素で' : 'コールバックで',
      from: 'code',
      branches: [
        { key: 'body', label: iterates ? '各要素で' : 'コールバックで', nodes },
        { key: 'skip', label: iterates ? '要素がない' : '呼ばれない', nodes: [] },
      ],
    };
    this.own.set(loop, `${this.code(callee)}(…)`);
    return loop;
  }
}

/** The parameters of a function as code: `c, { a, b }`. */
function parameterList(file: SourceFile, declaration: Node): string {
  const parameters = (any(declaration)['parameters'] as Node[] | undefined) ?? [];
  return parameters
    .map((parameter) => {
      const name = any(parameter)['name'] as Node;
      if (is(name, SyntaxKind.Identifier)) return `${any(parameter)['dotDotDotToken'] ? '...' : ''}${name['text'] as string}`;
      const names = bindingNames(textOf(file, name).replace(/\s+/g, ' '));
      return `{ ${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''} }`;
    })
    .join(', ');
}

/** The signature of a frame: its name and parameters. */
export function signatureOf(file: SourceFile, name: string, declaration: Node): string {
  return shorten(`${name}(${parameterList(file, declaration)})`, 80);
}

/** Build the tree of a frame (see the module comment). */
export function buildTree(context: TreeContext, input: FrameInput): BuiltTree {
  const builder = new Builder(context);
  const file = context.file;
  const body = any(input.declaration)['body'] as Node | undefined;
  let nodes: TreeNode[] = [];
  let bodyOpen = startLine(file, input.declaration);
  let bodyClose = endLine(file, input.declaration);
  if (body !== undefined && is(body, SyntaxKind.Block)) {
    bodyOpen = startLine(file, body);
    bodyClose = endLine(file, body);
    nodes = builder.list(body['statements'] as Node[], bodyOpen + 1);
  } else if (body !== undefined) {
    // A concise arrow function: its expression is what it returns.
    bodyOpen = startLine(file, body);
    const pre = builder.evaluate(body, 'value');
    const node: TreeNode = { id: '', kind: 'return', lines: [startLine(file, body), endLine(file, body)], code: shorten(`return ${builder.compact(body)}`, 80) };
    builder.own.set(node, `return ${flat(codeText(file, body))}`);
    if (pre.length > 0) node.pre = pre;
    nodes = [node];
  }
  const last = nodes[nodes.length - 1]?.lines[1] ?? bodyOpen;
  // Without an end of the body to reach, the lines below the last statement are its own.
  const tail = nodes[nodes.length - 1];
  if (ends(nodes) && tail !== undefined && bodyClose - 1 > tail.lines[1]) extend(tail, bodyClose - 1);
  if (!ends(nodes)) {
    const end: TreeNode = { id: '', kind: 'end', lines: [Math.min(last + 1, bodyClose), bodyClose], code: '終わり' };
    builder.own.set(end, 'end');
    nodes.push(end);
  }
  place(nodes, 's');
  const tree: FlowTree = {
    id: input.id,
    name: input.name,
    signature: input.signature,
    file: input.file,
    lines: [input.firstLine, input.lastLine ?? endLine(file, input.declaration)],
    head: [startLine(file, input.declaration), bodyOpen],
    nodes,
  };
  if (builder.implementations.length > 0) tree.implements = builder.implementations;
  if (builder.deferred.size > 0) tree.deferred = [...builder.deferred].sort();
  return { tree, uses: builder.uses, own: builder.own };
}

/** Every node of a tree, depth first, each with the list it is in. */
export function* nodesOf(nodes: readonly TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    yield node;
    if (node.pre !== undefined) yield* nodesOf(node.pre);
    for (const branch of node.branches ?? []) yield* nodesOf(branch.nodes);
  }
}
