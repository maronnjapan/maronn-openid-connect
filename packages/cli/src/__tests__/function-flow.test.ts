import { describe, expect, it } from 'vitest';
import {
  buildFunctionFlow,
  codeMaskOf,
  parameterNames,
  tokenize,
  type FunctionFlow,
} from '../extract/function-flow.js';
import { analyzeFunctions, type FunctionRoot } from '../extract/functions.js';
import { functionProject } from '../extract/templates.js';
import { buildOpFlow } from '../flow/build.js';
import { FEATURE_CONFIG_KEYS } from '../registry.js';

/**
 * The flow of the body of `source` (one function), with every name of `known`
 * resolving to `lib#<name>` and every method call of a receiver in `members`
 * to the member `Receiver.method`.
 */
function flowOf(source: string, known: readonly string[] = [], members: readonly string[] = []): FunctionFlow | undefined {
  const open = source.indexOf('{');
  let depth = 0;
  let close = open;
  for (; close < source.length; close += 1) {
    if (source[close] === '{') depth += 1;
    else if (source[close] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const parameters = source.slice(source.indexOf('(') + 1, source.indexOf(')'));
  return buildFunctionFlow({
    source,
    body: { start: open, end: close + 1 },
    name: 'subject',
    parameters,
    resolve: (name) => (known.includes(name) ? `lib#${name}` : undefined),
    resolveMember: (receiver, method) => {
      const name = receiver[receiver.length - 1] ?? '';
      return members.includes(name) ? `${name[0]?.toUpperCase()}${name.slice(1)}.${method}` : undefined;
    },
  });
}

/** The boxes as `kind:label` and the arrows as `from>to[label]`, for compact assertions. */
function shape(flow: FunctionFlow | undefined): { nodes: string[]; edges: string[] } {
  const nodes = flow?.nodes ?? [];
  const label = (id: string) => nodes.find((node) => node.id === id)?.label ?? id;
  return {
    nodes: nodes.map((node) => `${node.kind}:${node.label}`),
    edges: (flow?.edges ?? []).map((edge) => `${label(edge.from)}>${label(edge.to)}${edge.label === undefined ? '' : `[${edge.label}]`}${edge.kind === 'error' ? '!' : ''}`),
  };
}

describe('tokenize', () => {
  it('should read a slash after a value as a division and after an operator as a regular expression', () => {
    const source = 'a / b; x.replace(/"/g, "&quot;")';
    const { tokens } = tokenize(source, 0, source.length);
    expect(tokens.map((token) => token.type)).toEqual(['word', 'punct', 'word', 'punct', 'word', 'punct', 'word', 'punct', 'regex', 'punct', 'string', 'punct']);
  });

  it('should tokenize the code inside a template literal in place', () => {
    const source = '`a${f(x)}b`';
    const { tokens } = tokenize(source, 0, source.length);
    expect(tokens.map((token) => token.text)).toEqual(['`a${', 'f', '(', 'x', ')', '}b`']);
  });

  it('should keep reading past a JSX closing tag and an apostrophe of a JSX text', () => {
    const source = "<p>Don't</p>; next()";
    const { tokens } = tokenize(source, 0, source.length);
    expect(tokens.slice(-4).map((token) => token.text)).toEqual([';', 'next', '(', ')']);
  });

  it('should collect the comments apart from the tokens', () => {
    const source = '// first\na(); /* second */';
    const { tokens, comments } = tokenize(source, 0, source.length);
    expect(comments.map((comment) => comment.text)).toEqual(['// first', '/* second */']);
    expect(tokens.map((token) => token.text)).toEqual(['a', '(', ')', ';']);
  });
});

describe('codeMaskOf', () => {
  it('should mark strings, comments, regular expressions and template text as not code', () => {
    const source = "f('x'); // c\ng(/'/g, `t${h()}`)";
    const mask = codeMaskOf(source);
    const code = [...source].filter((_char, index) => mask[index] === 1).join('');
    expect(code.replace(/\s/g, '')).toEqual('f();g(,h())');
  });
});

describe('parameterNames', () => {
  it('should keep the names and leave out the types and defaults', () => {
    expect(parameterNames('c: any, params: Record<string, string>, { a, b }: Pair = {}, ...rest: string[]')).toBe('c, params, { a, b }, ...rest');
    expect(parameterNames('')).toBe('');
  });
});

describe('buildFunctionFlow', () => {
  describe('sequence', () => {
    it('should chain the calls of the catalog in order from the start to the return', () => {
      const flow = flowOf('function f(a, b) {\n  const x = parse(a);\n  helper(b);\n  return build(x);\n}', ['parse', 'build']);
      expect(shape(flow)).toEqual({
        nodes: ['start:subject(a, b)', 'call:parse', 'call:build', 'return:return build(…)'],
        edges: ['subject(a, b)>parse', 'parse>build', 'build>return build(…)'],
      });
    });

    it('should take the calls of a statement in the order they finish', () => {
      const flow = flowOf('function f() {\n  return outer(inner(1));\n}', ['outer', 'inner']);
      expect(shape(flow).nodes).toEqual(['start:subject()', 'call:inner', 'call:outer', 'return:return outer(…)']);
    });

    it('should end at an end box when the body runs out without a return', () => {
      const flow = flowOf('function f() {\n  store(1);\n}', ['store']);
      expect(shape(flow).nodes).toEqual(['start:subject()', 'call:store', 'end:end']);
    });

    it('should point every box at the card of its callee and at its line', () => {
      const flow = flowOf('function f() {\n\n  store(1);\n}', ['store']);
      expect(flow?.nodes[1]).toEqual({ id: 'n1', kind: 'call', label: 'store', callee: 'lib#store', line: 3 });
    });
  });

  describe('branches', () => {
    it('should short-circuit a compound early-return condition without introducing an impossible outcome', () => {
      const flow = flowOf('function f(ok) { if (ok && check()) return cached(); return fresh(); }', ['check', 'cached', 'fresh']);
      const condition = flow?.nodes.find((node) => node.label === 'ok');
      const skip = flow?.edges.find((edge) => edge.from === condition?.id && edge.label === 'false');
      expect(flow?.nodes.find((node) => node.id === skip?.to)?.label).toBe('fresh');
      const take = flow?.edges.find((edge) => edge.from === condition?.id && edge.label === 'true');
      expect(flow?.nodes.find((node) => node.id === take?.to)?.label).toBe('check');
    });

    it('should stop nested early returns and omit code unreachable after both branches return', () => {
      const flow = flowOf('function f(x) { if (x) { if (x.bad) return fail(); return cached(); } else { return fresh(); } unreachable(); }', ['fail', 'cached', 'fresh', 'unreachable']);
      expect(flow?.nodes.some((node) => node.label === 'unreachable')).toBe(false);
      const exits = flow?.nodes.filter((node) => node.kind === 'return') ?? [];
      expect(exits).toHaveLength(3);
      expect(flow?.edges.some((edge) => exits.some((node) => node.id === edge.from))).toBe(false);
    });

    it('should honor the automatic semicolon after return followed by a newline', () => {
      const flow = flowOf('function f() { return\n work(); }', ['work']);
      expect(shape(flow)).toEqual({ nodes: ['start:subject()', 'return:return'], edges: ['subject()>return'] });
    });

    it.each(['??', '||', '&&'])('should guard the fallback call of %s instead of always executing it', (operator) => {
      const flow = flowOf(`function f(value) { const result = value ${operator} fallback(); return result; }`, ['fallback']);
      const condition = flow?.nodes.find((node) => node.kind === 'condition');
      const call = flow?.nodes.find((node) => node.kind === 'call');
      const take = operator === '??' ? 'nullish' : operator === '||' ? 'false' : 'true';
      expect(flow?.edges.find((edge) => edge.to === call?.id)).toMatchObject({ from: condition?.id, kind: 'branch', label: take });
      expect(flow?.edges.filter((edge) => edge.from === condition?.id)).toHaveLength(2);
    });

    it('should guard the two calls of a conditional return separately', () => {
      const flow = flowOf('function f(ok) { return ok ? accept() : reject(); }', ['accept', 'reject']);
      expect(shape(flow).edges.slice(0, 3)).toEqual(['subject(ok)>ok', 'ok>accept[true]', 'ok>reject[false]']);
    });

    it('should send each failing call and explicit throw to catch from its own node', () => {
      const flow = flowOf('function f() { try { first(); second(); throw new Error("bad"); } catch (error) { return recover(error); } }', ['first', 'second', 'recover']);
      const labels = flow?.edges.filter((edge) => edge.kind === 'error').map((edge) => flow.nodes.find((node) => node.id === edge.from)?.label);
      expect(labels).toEqual(['first', 'second', 'throw Error(bad)']);
    });

    it('should keep exceptions handled by an inner catch out of the outer catch', () => {
      const flow = flowOf('function f() { try { try { first(); } catch (error) { recover(); } second(); } catch (error) { outer(); } }', ['first', 'recover', 'second', 'outer']);
      const outer = flow?.nodes.find((node) => node.label === 'outer');
      expect(flow?.edges.filter((edge) => edge.to === outer?.id).map((edge) => flow.nodes.find((node) => node.id === edge.from)?.label)).toEqual(['recover', 'second']);
    });

    it('should show both outcomes of an explicit condition', () => {
      const flow = flowOf('function f(x) {\n  if (!x.ok) {\n    reject(x);\n  }\n  accept(x);\n}', ['reject', 'accept']);
      expect(shape(flow).edges).toEqual(['subject(x)>!x.ok', '!x.ok>reject[true]', 'reject>accept', '!x.ok>accept[false]', 'accept>end']);
    });

    it('should label the else branch and join both branches after the if', () => {
      const flow = flowOf('function f(x) {\n  if (x) a(); else b();\n  c();\n}', ['a', 'b', 'c']);
      expect(shape(flow).edges).toEqual(['subject(x)>x', 'x>a[true]', 'x>b[false]', 'a>c', 'b>c', 'c>end']);
    });

    it('should read else if as one chain of conditions', () => {
      const flow = flowOf('function f(x) {\n  if (x === 1) a();\n  else if (x === 2) b();\n  else c();\n}', ['a', 'b', 'c']);
      expect(shape(flow).edges).toEqual(['subject(x)>x === 1', 'x === 1>a[true]', 'x === 1>x === 2[false]', 'x === 2>b[true]', 'x === 2>c[false]', 'a>end', 'b>end', 'c>end']);
    });

    it('should retain a condition even when its branches only assign values', () => {
      const flow = flowOf('function f(x) {\n  let y = 0;\n  if (x) { y = 1; } else { y = 2; }\n  return use(y);\n}', ['use']);
      expect(shape(flow).edges).toEqual(['subject(x)>x', 'x>use[true]', 'x>use[false]', 'use>return use(…)']);
    });

    it('should run the calls of a condition before the branch', () => {
      const flow = flowOf('function f(x) {\n  if (!isValid(x)) throw new TokenError(TokenErrorCode.InvalidRequest, "bad");\n  return x;\n}', ['isValid']);
      expect(shape(flow)).toEqual({
        nodes: ['start:subject(x)', 'call:isValid', 'condition:!isValid(x)', 'throw:throw TokenError(InvalidRequest)', 'return:return x'],
        edges: ['subject(x)>isValid', 'isValid>!isValid(x)', '!isValid(x)>throw TokenError(InvalidRequest)[true]', '!isValid(x)>return x[false]'],
      });
    });

    it('should branch a switch by its cases, default included', () => {
      const flow = flowOf("function f(kind) {\n  switch (kind) {\n    case 'a':\n      return a();\n    case 'b':\n      b();\n      break;\n    default:\n      throw new Error('kind');\n  }\n  return done();\n}", ['a', 'b', 'done']);
      expect(shape(flow).edges).toEqual([
        "subject(kind)>a[case 'a']",
        'a>return a()',
        "subject(kind)>b[case 'b']",
        'subject(kind)>throw Error(kind)[default]',
        'b>done',
        'done>return done()',
      ]);
    });

    it('should label the arrow into the body of a loop with its header', () => {
      const flow = flowOf('function f(items) {\n  for (const item of items) {\n    check(item);\n  }\n}', ['check']);
      expect(shape(flow).edges).toEqual(['subject(items)>check[for (const item of items)]', 'subject(items)>end', 'check>end']);
    });

    it('should enter a catch block on an error arrow', () => {
      const flow = flowOf('function f() {\n  try {\n    return run();\n  } catch (error) {\n    return respondError(error);\n  }\n}', ['run', 'respondError']);
      expect(shape(flow).edges).toEqual(['subject()>run', 'run>return run()', 'run>respondError[catch]!', 'respondError>return respondError(…)']);
    });
  });

  describe('boxes', () => {
    it('should make a box of a method of a resolver or a store the code holds, naming the member it reaches', () => {
      const flow = flowOf("function f(c) {\n  const resolver = c.get('consentResolver');\n  await consentResolver?.recordConsent?.('s');\n  c.json({});\n}", [], ['consentResolver']);
      expect(shape(flow).nodes).toEqual(['start:subject(c)', 'dynamic:consentResolver.recordConsent', 'end:end']);
      expect(flow?.nodes[1]?.member).toBe('ConsentResolver.recordConsent');
    });

    it('should make no box of a method no interface of the roots declares (a call into a framework)', () => {
      const flow = flowOf('function f() {\n  const value = cookieStore.get("sid");\n  return value;\n}');
      expect(shape(flow).nodes).toEqual(['start:subject()', 'return:return value']);
    });

    it('should name a returned object by its keys', () => {
      const flow = flowOf('function f(a) {\n  return { tokenClient: a, authenticatedClientId: a.id, ...rest };\n}');
      expect(shape(flow).nodes[1]).toBe('return:return { tokenClient, authenticatedClientId, ...rest }');
    });

    it('should attach the comment above a statement to its first box, and a trailing comment to none', () => {
      const flow = flowOf('function f() {\n  a(); // trailing\n  // RFC 6749 §5.2: the client must exist.\n  b();\n}', ['a', 'b']);
      expect(flow?.nodes.map((node) => node.note)).toEqual([undefined, undefined, 'RFC 6749 §5.2: the client must exist.', undefined]);
    });

    it('should not take a method defined in an object literal, nor a nested declaration, for a call: their bodies run later', () => {
      const flow = flowOf('function f() {\n  function inner() { a(); }\n  const resolver = {\n    async b(code) {\n      return a(code);\n    },\n  };\n  return resolver;\n}', ['a', 'b']);
      expect(shape(flow).nodes).toEqual(['start:subject()', 'return:return resolver']);
    });
  });

  it('should give no flow for a body whose brackets do not balance', () => {
    expect(flowOf('function f() {\n  a(;\n}', ['a'])).toBe(undefined);
  });
});

describe('FunctionProject.flowOf', () => {
  const roots: FunctionRoot[] = [
    {
      name: 'core',
      specifier: '@maronn-openid-connect/core',
      files: new Map([
        ['escape.ts', '/** Escape. */\nexport function escape(value: string): string {\n  return value.replace(/"/g, "&quot;");\n}\n\n/** Page. */\nexport function page(value: string): string {\n  return wrap(escape(value));\n}\n\n/** Wrap. */\nfunction wrap(value: string): string {\n  return `<p>${value}</p>`;\n}\n'],
        ['consent.ts', 'export interface ConsentResolver {\n  /** Return whether the subject granted every scope. */\n  hasConsent(subject: string): Promise<boolean>;\n}\n'],
      ]),
    },
  ];
  const project = analyzeFunctions(roots);

  it('should read the body after a regular expression with a quote in it, the flow in the order the calls run', () => {
    expect(project.catalog.functions['core:escape.ts#page']?.calls).toEqual(['core:escape.ts#wrap', 'core:escape.ts#escape']);
    expect(project.flowOf('core:escape.ts#page')?.nodes.map((node) => node.label)).toEqual(['page(value)', 'escape', 'wrap', 'return wrap(…)']);
  });

  it('should give no flow for an unknown id', () => {
    expect(project.flowOf('core:escape.ts#missing')).toBe(undefined);
  });

  it('should reach the member through the type of a parameter, of a property of one, or the key read from the context', () => {
    const typed = analyzeFunctions([
      {
        name: 'core',
        files: new Map([
          ['store.ts', 'export interface RecordStore {\n  /** Replace a record. */\n  update(record: string): Promise<void>;\n}\nexport interface OtherStore {\n  /** Replace another record. */\n  update(record: string): Promise<void>;\n}\nexport interface Input {\n  store: RecordStore;\n}\nexport interface ClientStore {\n  /** Save a client. */\n  save(client: string): Promise<void>;\n}\n'],
          ['use.ts', "/** A. */\nexport async function a(store: Pick<RecordStore, 'update'>): Promise<void> {\n  await store.update('x');\n}\n/** B. */\nexport async function b(input: Input): Promise<void> {\n  await input.store.update('x');\n}\n/** C. */\nexport async function c(ctx: any): Promise<void> {\n  const store = ctx.get('clientStore');\n  await store.save('x');\n}\n"],
        ]),
      },
    ]);
    const members = (id: string) => typed.flowOf(id)?.nodes.filter((node) => node.kind === 'dynamic').map((node) => node.member);
    expect(members('core:use.ts#a')).toEqual(['RecordStore.update']);
    expect(members('core:use.ts#b')).toEqual(['RecordStore.update']);
    expect(members('core:use.ts#c')).toEqual(['ClientStore.save']);
  });

  it('should describe a method of a resolver by the JSDoc of the member of its interface', () => {
    expect(project.describeMember('consentResolver.hasConsent')).toEqual({
      type: 'ConsentResolver',
      member: 'hasConsent',
      summary: 'Return whether the subject granted every scope.',
      package: 'core',
      module: 'consent.ts',
      line: 3,
    });
    expect(project.describeMember('consentResolver.forget')).toBe(undefined);
  });
});

describe('the flows of the repository', () => {
  const project = functionProject();

  it('should give every function a flow, and every member a box reaches a summary', () => {
    const withoutFlow: string[] = [];
    const undescribed = new Set<string>();
    for (const id of Object.keys(project.catalog.functions)) {
      const flow = project.flowOf(id);
      if (flow === undefined) withoutFlow.push(id);
      for (const node of flow?.nodes ?? []) {
        if (node.member !== undefined && (project.memberById(node.member)?.summary ?? '') === '') undescribed.add(node.member);
      }
    }
    expect(withoutFlow).toEqual([]);
    expect([...undescribed]).toEqual([]);
  });

  it('should describe every call a step names beside its source (the meta calls of every feature)', () => {
    const features = Object.fromEntries(FEATURE_CONFIG_KEYS.map((key) => [key, true]));
    const names = new Set(buildOpFlow({ features }).endpoints.flatMap((endpoint) => endpoint.steps.flatMap((step) => step.dynamicCalls ?? [])));
    expect([...names].filter((name) => project.describeMember(name) === undefined)).toEqual([]);
  });
});
