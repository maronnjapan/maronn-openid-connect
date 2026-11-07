/**
 * What a test expects, in words: an `expect(actual).matcher(expected)` read
 * as its structure (the code of `actual`, the matcher, `.not`, `.resolves`,
 * `.rejects`, the expected value when it is a literal) and said in English
 * by a table of rules, the first that fits.
 *
 * Each rule says its sentence through a phrase with holes (`the HTTP status
 * is {int}`), the same way a step definition of the feature files does, so
 * the expectations of the code and the steps share one translation table
 * (tests/steps/ja.yaml). A phrase that also is a step expression is written
 * the same (`the HTTP status is {int}`, `the error code is {string}`).
 *
 * The rules are rules, not guesses: an expectation no rule fits keeps its
 * code (`` `x` toBeCloseTo 3 ``).
 */

/** An expected value as the reader found it: a literal (a string, a number, a regular expression, an object or array of literals), or code. */
export type Value =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'regexp'; source: string }
  | { kind: 'object'; entries: Array<[string, Value]> }
  | { kind: 'array'; items: Value[] }
  | { kind: 'code'; code: string };

/** An expectation as the reader found it. */
export interface Expectation {
  /** The code of the value checked (`response.status`, `await response.json()`). */
  actual: string;
  matcher: string;
  /** The arguments of the matcher. */
  args: Value[];
  negated: boolean;
  mode?: 'resolves' | 'rejects';
}

/** What a rule says: the sentence, the phrase it fills, and the values of its holes in order. */
export interface Said {
  text: string;
  phrase: string;
  holes: string[];
}

/** A value as the page shows it: a string or code in backticks, a number as it is, a regular expression between slashes. */
export function valueWords(value: Value): string {
  switch (value.kind) {
    case 'string':
      return `\`${value.value}\``;
    case 'number':
      return String(value.value);
    case 'boolean':
      return String(value.value);
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'regexp':
      return `/${value.source}/`;
    case 'object':
      return value.entries.length === 0 ? 'an empty object' : value.entries.map(([key, entry]) => `\`${key}\` ${valueWords(entry)}`).join(' and ');
    case 'array':
      return value.items.length === 0 ? 'an empty list' : `[${value.items.map(valueWords).join(', ')}]`;
    case 'code':
      return `\`${shortCode(value.code)}\``;
  }
}

/** A value as plain data (what the card keeps as `expected`), or undefined for code. */
export function plainValue(value: Value): unknown {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'regexp':
      return `/${value.source}/`;
    case 'object': {
      const entries = value.entries.map(([key, entry]) => [key, plainValue(entry)] as const);
      return entries.some(([, entry]) => entry === undefined) && value.entries.some(([, entry]) => entry.kind === 'code') ? undefined : Object.fromEntries(entries);
    }
    case 'array': {
      const items = value.items.map(plainValue);
      return value.items.some((item) => item.kind === 'code') ? undefined : items;
    }
    case 'code':
      return undefined;
  }
}

/** Code on one line, cut to a length the page can show. */
export function shortCode(code: string): string {
  const flat = code.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** The checked value in words: `the body` for the parsed body of a response, else its code in backticks. */
export function actualWords(code: string): string {
  const flat = shortCode(code)
    .replace(/^\(\s*await\s+([\s\S]*)\)$/, '$1')
    .replace(/^await\s+/, '');
  if (/^(body|json|payload)$/.test(flat) || /\.json\(\)$/.test(flat) || /^[A-Za-z_$][\w$]*\.body$/.test(flat)) return 'the body';
  return `\`${flat}\``;
}

/** The name of a header an actual reads (`response.headers.get('Cache-Control')`, `headers['cache-control']`), or undefined. */
export function headerOf(code: string): string | undefined {
  const match = /\.headers(?:\.get\(\s*['"`]([^'"`]+)['"`]\s*\)|\[\s*['"`]([^'"`]+)['"`]\s*\])$/.exec(code.trim());
  return match?.[1] ?? match?.[2];
}

/** Whether an actual is the status of a response (`response.status`, `res.statusCode`). */
export function isStatus(code: string): boolean {
  return /(^|\.)status(Code)?$/.test(code.trim().replace(/\?\./g, '.'));
}

/** The literal an argument is when it is a string or a number, for the holes of a phrase. */
function hole(value: Value | undefined): string {
  if (value === undefined) return '';
  if (value.kind === 'string') return value.value;
  if (value.kind === 'number') return String(value.value);
  return valueWords(value);
}

/** The error a failure names: the `error` (or `code`) of an object, a string, or the class of an error. */
export function errorNamed(value: Value | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.kind === 'object') {
    const entry = value.entries.find(([key]) => key === 'error' || key === 'code');
    return entry?.[1].kind === 'string' ? entry[1].value : undefined;
  }
  if (value.kind === 'string') return value.value;
  if (value.kind !== 'code') return undefined;
  const code = value.code.trim();
  if (/^[A-Z][\w$]*(Error|Exception)$/.test(code)) return code;
  // `new CibaGrantError('unauthorized_client', '…')`: the code is its first argument.
  const constructed = /^new\s+[A-Z][\w$]*(?:Error|Exception)\(\s*['"`]([\w.:-]+)['"`]/.exec(code);
  return constructed?.[1];
}

const NOT = (negated: boolean) => (negated ? ' not' : '');

/** Say an expectation in words (see the module comment). */
export function sayExpectation(expectation: Expectation): Said {
  const { actual, matcher, args, negated, mode } = expectation;
  const [first] = args;
  const subject = actualWords(actual);
  const header = headerOf(actual);
  const say = (text: string, phrase: string, ...holes: string[]): Said => ({ text, phrase, holes });

  // A promise or a function that fails, and what it fails with.
  if (mode === 'rejects' || /^toThrow(Error)?$/.test(matcher)) {
    if (negated && mode !== 'rejects') return say('does not fail', 'does not fail');
    const error = errorNamed(first) ?? (first?.kind === 'regexp' ? valueWords(first) : undefined);
    if (mode === 'rejects' && matcher === 'toBeInstanceOf' && first !== undefined) return say(`fails with ${valueWords(first)}`, 'fails with {string}', hole(first));
    if (error !== undefined) return say(`fails with \`${error.replace(/^`|`$/g, '')}\``, 'fails with {string}', error);
    if (first !== undefined && first.kind === 'object') return say(`fails with ${valueWords(first)}`, 'fails with {value}', valueWords(first));
    return say('fails', 'fails');
  }

  // The status and the headers of a response.
  if (isStatus(actual) && (matcher === 'toBe' || matcher === 'toEqual') && first?.kind === 'number') {
    return say(`the HTTP status is${NOT(negated)} ${first.value}`, `the HTTP status is${NOT(negated)} {int}`, String(first.value));
  }
  if (header !== undefined) {
    if (matcher === 'toBeNull' || matcher === 'toBeUndefined') return say(negated ? `there is a \`${header}\` header` : `there is no \`${header}\` header`, negated ? 'there is a {string} header' : 'there is no {string} header', header);
    if ((matcher === 'toBe' || matcher === 'toEqual') && first !== undefined) return say(`the \`${header}\` header is${NOT(negated)} ${valueWords(first)}`, `the {string} header is${NOT(negated)} {string}`, header, hole(first));
    if ((matcher === 'toContain' || matcher === 'toMatch') && first !== undefined) {
      const verb = matcher === 'toContain' ? 'contains' : 'matches';
      return say(`the \`${header}\` header ${negated ? `does not ${verb.slice(0, -1)}` : verb} ${valueWords(first)}`, `the {string} header ${negated ? `does not ${verb.slice(0, -1)}` : verb} {string}`, header, hole(first));
    }
  }

  // The error code of a body or a result.
  const code = errorNamed(first);
  if ((matcher === 'toMatchObject' || matcher === 'toEqual' || matcher === 'toStrictEqual') && code !== undefined && first?.kind === 'object' && !negated) {
    return say(`the error code is \`${code}\``, 'the error code is {string}', code);
  }
  if (/(^|\.)error$/.test(actual.trim()) && (matcher === 'toBe' || matcher === 'toEqual') && first?.kind === 'string') {
    return say(`the error code is${NOT(negated)} \`${first.value}\``, `the error code is${NOT(negated)} {string}`, first.value);
  }

  // The URL of a page.
  if (matcher === 'toHaveURL' && first !== undefined) {
    if (first.kind === 'regexp') {
      const ending = /^(?:\^?\.\*)?((?:\\\/|[\w-])+)\$$/.exec(first.source);
      if (ending !== undefined && ending !== null) {
        const tail = (ending[1] as string).replace(/\\\//g, '/');
        return say(`the URL${negated ? ' does not end' : ' ends'} with \`${tail}\``, `the URL${negated ? ' does not end' : ' ends'} with {string}`, tail);
      }
      return say(`the URL${negated ? ' does not match' : ' matches'} ${valueWords(first)}`, `the URL${negated ? ' does not match' : ' matches'} {value}`, valueWords(first));
    }
    return say(`the URL is${NOT(negated)} ${valueWords(first)}`, `the URL is${NOT(negated)} {value}`, valueWords(first));
  }

  const value = first === undefined ? '' : valueWords(first);
  // A promise that resolves: what it resolves to.
  if (mode === 'resolves') {
    const word = { toBeUndefined: 'undefined', toBeNull: 'null', toBeDefined: 'a value', toBeTruthy: 'a truthy value', toBeFalsy: 'a falsy value' }[matcher];
    if (word !== undefined) return say(`${subject} resolves to${NOT(negated)} ${word}`, `{code} resolves to${NOT(negated)} ${word}`, subject);
    if (matcher === 'toBe' || matcher === 'toEqual' || matcher === 'toStrictEqual') return say(`${subject} resolves to${NOT(negated)} ${value}`, `{code} resolves to${NOT(negated)} {value}`, subject, value);
    if (matcher === 'toMatchObject') return say(`${subject} resolves to a value${negated ? ' without' : ' with'} ${value}`, `{code} resolves to a value${negated ? ' without' : ' with'} {value}`, subject, value);
  }
  switch (matcher) {
    case 'toBe':
      return say(`${subject} is${NOT(negated)} ${value}`, `{code} is${NOT(negated)} {value}`, subject, value);
    case 'toEqual':
    case 'toStrictEqual':
      return say(`${subject}${negated ? ' does not equal' : ' equals'} ${value}`, `{code}${negated ? ' does not equal' : ' equals'} {value}`, subject, value);
    case 'toMatchObject':
      return say(`${subject}${negated ? ' does not have' : ' has'} ${value}`, `{code}${negated ? ' does not have' : ' has'} {value}`, subject, value);
    case 'toBeUndefined':
    case 'toBeNull':
    case 'toBeDefined':
    case 'toBeTruthy':
    case 'toBeFalsy': {
      const word = { toBeUndefined: 'undefined', toBeNull: 'null', toBeDefined: 'defined', toBeTruthy: 'truthy', toBeFalsy: 'falsy' }[matcher];
      return say(`${subject} is${NOT(negated)} ${word}`, `{code} is${NOT(negated)} ${word}`, subject);
    }
    case 'toBeInstanceOf':
      return say(`${subject} is${negated ? ' not' : ''} a ${value}`, `{code} is${negated ? ' not' : ''} a {value}`, subject, value);
    case 'toHaveLength':
      return say(`the length of ${subject} is${NOT(negated)} ${value}`, `the length of {code} is${NOT(negated)} {int}`, subject, hole(first));
    case 'toContain':
    case 'toContainEqual':
      return say(`${subject}${negated ? ' does not contain' : ' contains'} ${value}`, `{code}${negated ? ' does not contain' : ' contains'} {value}`, subject, value);
    case 'toMatch':
      return say(`${subject}${negated ? ' does not match' : ' matches'} ${value}`, `{code}${negated ? ' does not match' : ' matches'} {value}`, subject, value);
    case 'toHaveProperty':
      return say(`${subject}${negated ? ' does not have' : ' has'} the property ${value}`, `{code}${negated ? ' does not have' : ' has'} the property {value}`, subject, value);
    case 'toHaveBeenCalled':
      return say(`${subject} was${NOT(negated)} called`, `{code} was${NOT(negated)} called`, subject);
    case 'toHaveBeenCalledTimes':
      return say(`${subject} was called ${value} times`, '{code} was called {int} times', subject, hole(first));
    case 'toHaveBeenCalledWith':
      return say(`${subject} was${NOT(negated)} called with ${args.map(valueWords).join(', ')}`, `{code} was${NOT(negated)} called with {value}`, subject, args.map(valueWords).join(', '));
    case 'toBeGreaterThan':
    case 'toBeGreaterThanOrEqual':
    case 'toBeLessThan':
    case 'toBeLessThanOrEqual': {
      const word = { toBeGreaterThan: 'greater than', toBeGreaterThanOrEqual: 'at least', toBeLessThan: 'less than', toBeLessThanOrEqual: 'at most' }[matcher];
      return say(`${subject} is${NOT(negated)} ${word} ${value}`, `{code} is${NOT(negated)} ${word} {value}`, subject, value);
    }
    case 'toHaveText':
    case 'toContainText':
      return say(`${subject}${negated ? ' does not have' : ' has'} the text ${value}`, `{code}${negated ? ' does not have' : ' has'} the text {value}`, subject, value);
    case 'toBeVisible':
      return say(`${subject} is${NOT(negated)} visible`, `{code} is${NOT(negated)} visible`, subject);
    case 'toHaveCount':
      return say(`${subject} has${negated ? ' not' : ''} ${value} elements`, `{code} has${negated ? ' not' : ''} {int} elements`, subject, hole(first));
    case 'toHaveValue':
      return say(`${subject}${negated ? ' does not have' : ' has'} the value ${value}`, `{code}${negated ? ' does not have' : ' has'} the value {value}`, subject, value);
    default:
      return say(`${subject}${negated ? ' not' : ''} ${matcher}${value === '' ? '' : ` ${value}`}`.trim(), '');
  }
}

/** Whether an expectation expects a failure: a rejection, a throw, a status of 400 or more, an error code (see outcomeOf). */
export function expectsFailure(expectation: Expectation): boolean {
  const [first] = expectation.args;
  if (expectation.mode === 'rejects') return true;
  if (/^toThrow(Error)?$/.test(expectation.matcher)) return !expectation.negated;
  if (expectation.negated) return false;
  if (isStatus(expectation.actual) && first?.kind === 'number') return first.value >= 400;
  if ((expectation.matcher === 'toMatchObject' || expectation.matcher === 'toEqual' || expectation.matcher === 'toStrictEqual') && first?.kind === 'object') return first.entries.some(([key, value]) => key === 'error' && value.kind === 'string');
  return /(^|\.)error$/.test(expectation.actual.trim()) && first?.kind === 'string';
}

/** The errors an expectation expects: the codes (`invalid_client`) and the classes (`TokenError`) it names. */
export function expectedErrors(expectation: Expectation): string[] {
  if (!expectsFailure(expectation)) return [];
  const [first] = expectation.args;
  const named = errorNamed(first);
  if (named !== undefined) return [named];
  if (first?.kind === 'code' && /^[A-Z][\w$]*$/.test(first.code.trim())) return [first.code.trim()];
  return [];
}

/** The matchers the rules say something of, for the list of the phrases. */
const SAID_MATCHERS = [
  'toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toBeUndefined', 'toBeNull', 'toBeDefined', 'toBeTruthy', 'toBeFalsy', 'toBeInstanceOf', 'toHaveLength',
  'toContain', 'toContainEqual', 'toMatch', 'toHaveProperty', 'toHaveBeenCalled', 'toHaveBeenCalledTimes', 'toHaveBeenCalledWith', 'toBeGreaterThan',
  'toBeGreaterThanOrEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'toHaveText', 'toContainText', 'toBeVisible', 'toHaveCount', 'toHaveValue', 'toThrow', 'toHaveURL',
];

/**
 * Every phrase an expectation of the code can be said with: the rules run
 * over each matcher, with and without `.not`, `.resolves` and `.rejects`, on
 * a status, a header, an error and a plain value. The keys of the translation
 * table that are not step expressions must be among these (the lint).
 */
export function expectationPhrases(): Set<string> {
  const phrases = new Set<string>();
  const actuals = ['response.status', "response.headers.get('Cache-Control')", 'body.error', 'value', 'page'];
  const args: Value[][] = [
    [],
    [{ kind: 'number', value: 401 }],
    [{ kind: 'string', value: 'x' }],
    [{ kind: 'object', entries: [['error', { kind: 'string', value: 'invalid_client' }]] }],
    [{ kind: 'object', entries: [['a', { kind: 'number', value: 1 }]] }],
    [{ kind: 'regexp', source: '\\/consent$' }],
    [{ kind: 'regexp', source: 'code=' }],
    [{ kind: 'code', code: 'TokenError' }],
  ];
  for (const matcher of SAID_MATCHERS) {
    for (const actual of actuals) {
      for (const argList of args) {
        for (const negated of [false, true]) {
          for (const mode of [undefined, 'resolves', 'rejects'] as const) {
            const said = sayExpectation({ actual, matcher, args: argList, negated, ...(mode === undefined ? {} : { mode }) });
            if (said.phrase !== '') phrases.add(said.phrase);
          }
        }
      }
    }
  }
  return phrases;
}
