/**
 * Wiring that is not an ordinary call from an endpoint body: middleware,
 * values put into an untyped request context, callbacks and module startup.
 *
 * A target identifies the function or member the types know; it does not
 * claim that registering or constructing it executes it. The scan keeps an
 * explicit diagnostic when it cannot prove the destination of that wiring.
 */
import type { WiringEntry } from './model.js';
import type { FileResolution, Resolver } from './resolve.js';
import { SyntaxKind, type Checker, type Node, type SourceFile, type TsType } from './ts.js';
import { codeText, endLine, is, isFunctionLike, nameOf, startLine, unwrap, walk } from './ast.js';

export interface WiringInput {
  file: SourceFile;
  /** The source key used by the map (`hono:oidc-provider/app.ts`). */
  fileId: string;
  resolver: Resolver;
  checker: Checker;
  resolution: FileResolution;
  /** Only iterations inside actual catalog or endpoint frames are represented by a flow tree. */
  tracedRanges?: readonly (readonly [number, number])[];
}

/** A reference whose declaration may describe a callable value. */
interface Argument {
  value: Node;
  declaration?: Node;
}

/** Whether the type is an untyped value, as Hono's request context is here. */
function isAny(type: TsType | undefined): boolean {
  return type !== undefined && type.isIntrinsicType() && (type as { intrinsicName?: string }).intrinsicName === 'any';
}

/** Whether an expression contains work at startup rather than merely a deferred definition. */
function initializes(node: Node): boolean {
  let found = false;
  walk(node, (child) => {
    if (isFunctionLike(child)) return false;
    if (is(child, SyntaxKind.CallExpression) || is(child, SyntaxKind.NewExpression)) found = true;
    return !found;
  });
  return found;
}

/** Whether a node is at module scope, outside every function or class body. */
function atModuleScope(node: Node): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (isFunctionLike(parent)) return false;
    if (is(parent, SyntaxKind.SourceFile)) return true;
  }
  return false;
}

/** Whether an object property supplies callable behavior rather than ordinary data. */
function callableProperty(property: Node, resolver: Resolver): boolean {
  if (is(property, SyntaxKind.MethodDeclaration)) return true;
  if (is(property, SyntaxKind.PropertyAssignment)) {
    const value = unwrap(property['initializer'] as Node);
    if (is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression)) return true;
    return resolver.callable(value);
  }
  return is(property, SyntaxKind.ShorthandPropertyAssignment) && resolver.callable(property['name'] as Node);
}

/** The diagnostic inventory of callable wiring in one source file, independently of catalog function boundaries. */
export function scanWiring(input: WiringInput): WiringEntry[] {
  const { file, fileId, resolver, checker, resolution } = input;
  const entries: WiringEntry[] = [];
  const argumentsToCheck: Argument[] = [];
  const contextWrites: Array<{ call: Node; receiver: Node; value: Node }> = [];
  const definitions: Node[] = [];
  const callbackRanges: Array<[number, number]> = [];
  const representedIterations = new Set<Node>();
  const seen = new Set<string>();
  const add = (kind: WiringEntry['kind'], node: Node, why: string, reference?: Node, targetId?: string) => {
    const id = `${fileId}:${kind}:${node.getStart(file)}`;
    if (seen.has(id)) return;
    seen.add(id);
    if (kind === 'callback') callbackRanges.push([node.getStart(file), node.end]);
    const value = reference === undefined ? undefined : unwrap(reference);
    const target = value === undefined ? undefined : resolution.targets.get(value) ?? resolver.reference(value);
    const targetName = targetId ?? (target === undefined || target.kind === 'untraceable' ? undefined : target.id);
    entries.push({
      id,
      file: fileId,
      lines: [startLine(file, node), endLine(file, node)],
      kind,
      code: codeText(file, node).replace(/\s+/g, ' ').trim(),
      status: 'untraceable',
      ...(targetName === undefined ? {} : { target: targetName }),
      why,
    });
  };

  walk(file, (node) => {
    if (is(node, SyntaxKind.ArrowFunction) || is(node, SyntaxKind.FunctionExpression)) definitions.push(node);
    if (is(node, SyntaxKind.FunctionDeclaration) && node['body'] !== undefined) {
      const modifiers = (node['modifiers'] as Node[] | undefined) ?? [];
      if (!is(node.parent, SyntaxKind.SourceFile) || node['name'] === undefined || modifiers.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword)) definitions.push(node);
    }
    if (is(node, SyntaxKind.VariableDeclaration) && node['initializer'] !== undefined) {
      const value = unwrap(node['initializer'] as Node);
      if (atModuleScope(node) && initializes(value)) add('initialization', node, 'モジュールの初期化で作る値から、利用するエンドポイントへの接続は未確定', value);
      if (is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression)) {
        add('callback', node, '関数値を変数に置く配線は、その値の利用先を確定できない');
      } else if (atModuleScope(node) && resolver.callable(value)) {
        add('callback', node, 'モジュールで関数値に付けた別名から、利用するエンドポイントへの接続は未確定', value);
      }
    }
    if (is(node, SyntaxKind.ExpressionStatement) && atModuleScope(node) && initializes(node)) {
      add('initialization', node, 'モジュールの初期化で行う処理はエンドポイントの処理本体の外にある');
    }
    if (is(node, SyntaxKind.ExportAssignment) && initializes(node)) {
      add('initialization', node, 'モジュールの export を作る処理から、利用するエンドポイントへの接続は未確定', node['expression'] as Node);
    }
    if (is(node, SyntaxKind.ReturnStatement) && node['expression'] !== undefined) {
      const value = unwrap(node['expression'] as Node);
      if (is(value, SyntaxKind.ObjectLiteralExpression)) {
        const methods = (value['properties'] as Node[]).filter((property) => callableProperty(property, resolver));
        if (methods.some((property) => !resolution.implementations.has(property))) {
          add('callback', node, '返す処理の束に、呼び出される型のメンバーと結び付かない実装がある');
        }
      }
    }
    if (is(node, SyntaxKind.CallExpression) || is(node, SyntaxKind.NewExpression)) {
      const callee = unwrap(node['expression'] as Node);
      const args = (node['arguments'] as Node[] | undefined) ?? [];
      const method = is(callee, SyntaxKind.PropertyAccessExpression) ? nameOf(callee['name']) : undefined;
      if (method === 'use' || method === 'route') {
        add('middleware', node, 'ミドルウェアの登録順・パス・動的な登録先から、適用するエンドポイントを確定できない', args.at(-1));
      }
      if (method === 'set' && args.length === 2 && is(callee, SyntaxKind.PropertyAccessExpression)) {
        contextWrites.push({ call: node, receiver: callee['expression'] as Node, value: args[1] as Node });
      }
      const withinFrame = (input.tracedRanges ?? []).some(([start, end]) => startLine(file, node) >= start && endLine(file, node) <= end);
      if (!withinFrame || !resolver.iterates(node)) {
        for (const argument of args) {
          const value = unwrap(argument);
          if (is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression)) {
            add('callback', value, 'コールバックを渡す配線は、その登録先と呼び出し時点を型だけでは確定できない');
          } else if (is(value, SyntaxKind.Identifier) || is(value, SyntaxKind.PropertyAccessExpression) || is(value, SyntaxKind.ElementAccessExpression)) {
            argumentsToCheck.push({ value });
          }
        }
      } else {
        for (const argument of args) representedIterations.add(unwrap(argument));
      }
    }
    if (is(node, SyntaxKind.MethodDeclaration) && is(node.parent, SyntaxKind.ObjectLiteralExpression)) {
      add('callback', node, 'オブジェクトに置いた処理の利用先は、その値の型と実装の接続で確認する必要がある', undefined, resolution.implementations.get(node));
    } else if (is(node, SyntaxKind.PropertyAssignment) && node['initializer'] !== undefined) {
      const value = unwrap(node['initializer'] as Node);
      if (is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression)) {
        add('callback', node, 'オブジェクトに置いた処理の利用先は、その値の型と実装の接続で確認する必要がある', undefined, resolution.implementations.get(node));
      } else if (is(value, SyntaxKind.Identifier) || is(value, SyntaxKind.PropertyAccessExpression) || is(value, SyntaxKind.ElementAccessExpression)) {
        argumentsToCheck.push({ value, declaration: node });
      }
    } else if (is(node, SyntaxKind.ShorthandPropertyAssignment)) {
      argumentsToCheck.push({ value: node['name'] as Node, declaration: node });
    }
    return true;
  });

  if (argumentsToCheck.length > 0) {
    argumentsToCheck.forEach((entry) => {
      if (!resolver.callable(entry.value)) return;
      add('callback', entry.declaration ?? entry.value, '名前で渡したコールバックの登録先と呼び出し時点は、型だけでは確定できない', entry.value, entry.declaration === undefined ? undefined : resolution.implementations.get(entry.declaration));
    });
  }
  if (contextWrites.length > 0) {
    const types = checker.getTypeAtLocation(contextWrites.map((entry) => entry.receiver));
    contextWrites.forEach((entry, index) => {
      if (!isAny(types[index])) return;
      add('context', entry.call, 'コンテキストへ設定する値の型は読めるが、値を作る処理から利用先への接続は未確定', entry.value);
    });
  }
  for (const definition of definitions) {
    if (representedIterations.has(definition)) continue;
    if (callbackRanges.some(([start, end]) => definition.getStart(file) >= start && definition.end <= end)) continue;
    add('callback', definition, '後から呼ばれる関数値の定義から、実際の呼び出し先とエンドポイントへの接続は未確定');
  }
  return entries.sort((a, b) => a.lines[0] - b.lines[0] || a.lines[1] - b.lines[1] || a.kind.localeCompare(b.kind));
}
