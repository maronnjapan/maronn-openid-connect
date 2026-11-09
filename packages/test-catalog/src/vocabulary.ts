/**
 * The closed vocabulary of the feature files and its Japanese: the step
 * definitions of tests/steps (each a Cucumber Expression, the first argument
 * of a `Given`, `When`, `Then` or `Step` call, a single-line string literal
 * as the lint requires) and the translation table tests/steps/ja.yaml.
 *
 * The Japanese of a step or of an expectation is built from its English
 * phrase, never written by hand for each test: the table maps a phrase (a
 * step expression, or the phrase an expectation of the code is said with,
 * words.ts) to a Japanese template whose `{0}`, `{1}` are the holes of the
 * phrase in their English order. A step matches exactly one expression and
 * hands over the values of its holes; a phrase the table does not have stays
 * English, and the page says so.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CucumberExpression, ParameterType, ParameterTypeRegistry } from '@cucumber/cucumber-expressions';
import { dialects } from '@cucumber/gherkin';
import { parse } from 'yaml';

/** Where the step definitions and the table are, from the root of the repository. */
export const STEPS_DIRECTORY = 'tests/steps';
export const TRANSLATIONS_FILE = 'tests/steps/ja.yaml';

/** A step definition: its keyword and expression where it is written. */
export interface StepDefinition {
  keyword: 'Given' | 'When' | 'Then' | 'Step';
  expression: string;
  file: string;
  line: number;
}

/** A call of a step definition in a source: the keyword, then the first argument as a string literal (or something else, which the lint refuses). */
const DEFINITION = /\b(Given|When|Then|Step)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|(\S))/g;
/** A parameter type a source defines: its name and regular expression. */
const PARAMETER_TYPE = /defineParameterType\(\s*(?:new\s+ParameterType\(\s*)?\{?[^)]*?name:\s*'([\w-]+)'[^)]*?regexp:\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/g;

/** The step definitions of a source, and the first arguments that are not a string literal (the lint fails on them). */
export function readDefinitions(text: string, file: string): { definitions: StepDefinition[]; invalid: Array<{ file: string; line: number; keyword: string }> } {
  const definitions: StepDefinition[] = [];
  const invalid: Array<{ file: string; line: number; keyword: string }> = [];
  for (const match of text.matchAll(DEFINITION)) {
    const line = text.slice(0, match.index).split('\n').length;
    const keyword = match[1] as StepDefinition['keyword'];
    if (match[2] === undefined) invalid.push({ file, line, keyword });
    else definitions.push({ keyword, expression: match[2].replace(/\\'/g, "'"), file, line });
  }
  return { definitions, invalid };
}

/** The parameter types a source defines (`defineParameterType({ name: 'grant', regexp: /.../ })`). */
export function readParameterTypes(text: string): Array<{ name: string; regexp: RegExp }> {
  const types: Array<{ name: string; regexp: RegExp }> = [];
  for (const match of text.matchAll(PARAMETER_TYPE)) {
    const literal = match[2] as string;
    const end = literal.lastIndexOf('/');
    try {
      types.push({ name: match[1] as string, regexp: new RegExp(literal.slice(1, end), literal.slice(end + 1)) });
    } catch {
      // Not a regular expression the reader can take; the step definitions using it do not match.
    }
  }
  return types;
}

/** The source files of a directory, recursively. */
function sourcesOf(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourcesOf(path);
    return /\.(m?[jt]s)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

/** The vocabulary: the step definitions of tests/steps and a matcher of step texts. */
export class Vocabulary {
  readonly definitions: StepDefinition[];
  readonly invalid: Array<{ file: string; line: number; keyword: string }>;
  private readonly expressions: Array<{ definition: StepDefinition; expression: CucumberExpression }> = [];

  constructor(definitions: StepDefinition[], invalid: Array<{ file: string; line: number; keyword: string }> = [], parameterTypes: Array<{ name: string; regexp: RegExp }> = []) {
    this.definitions = definitions;
    this.invalid = invalid;
    const registry = new ParameterTypeRegistry();
    for (const type of parameterTypes) {
      try {
        registry.defineParameterType(new ParameterType(type.name, type.regexp, String, (value: string) => value));
      } catch {
        // Defined twice, or a name the registry has: the first one stays.
      }
    }
    for (const definition of definitions) {
      try {
        this.expressions.push({ definition, expression: new CucumberExpression(definition.expression, registry) });
      } catch {
        // An expression with a type the reader does not know: it matches nothing here (bddgen reports it).
      }
    }
  }

  /** Read the step definitions of a directory of the repository (tests/steps). */
  static read(repository: string, directory = STEPS_DIRECTORY): Vocabulary {
    const definitions: StepDefinition[] = [];
    const invalid: Array<{ file: string; line: number; keyword: string }> = [];
    const types: Array<{ name: string; regexp: RegExp }> = [];
    for (const path of sourcesOf(join(repository, directory))) {
      const text = readFileSync(path, 'utf8');
      const file = relative(repository, path).split('\\').join('/');
      const read = readDefinitions(text, file);
      definitions.push(...read.definitions);
      invalid.push(...read.invalid);
      types.push(...readParameterTypes(text));
    }
    return new Vocabulary(definitions, invalid, types);
  }

  /** The definitions a step text matches, with the text of each hole as written (a string with its quotes). */
  matches(text: string): Array<{ definition: StepDefinition; holes: string[] }> {
    const found: Array<{ definition: StepDefinition; holes: string[] }> = [];
    for (const { definition, expression } of this.expressions) {
      const args = expression.match(text);
      if (args !== null) found.push({ definition, holes: args.map((arg) => arg.group.value ?? '') });
    }
    return found;
  }
}

/** The holes of a phrase: `{int}`, `{string}`, `{code}`, `{value}`, `{}`, a parameter type. */
export function holesOf(phrase: string): string[] {
  return [...phrase.replace(/\\[{}()/]/g, '').matchAll(/\{([\w-]*)\}/g)].map((match) => match[1] as string);
}

/** The translation table: phrase → Japanese template (see the module comment). */
export class Translations {
  constructor(readonly table: ReadonlyMap<string, string>) {}

  /** Read tests/steps/ja.yaml (a missing file is an empty table). */
  static read(repository: string, file = TRANSLATIONS_FILE): Translations {
    let text: string;
    try {
      text = readFileSync(join(repository, file), 'utf8');
    } catch {
      return new Translations(new Map());
    }
    return Translations.parse(text);
  }

  /** The table of a YAML text. */
  static parse(text: string): Translations {
    const data = (parse(text) ?? {}) as Record<string, unknown>;
    return new Translations(new Map(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
  }

  /** The Japanese of a phrase with the values of its holes, or undefined when the table does not have it. */
  translate(phrase: string, holes: readonly string[]): string | undefined {
    const template = this.table.get(phrase);
    if (template === undefined) return undefined;
    return template.replace(/\{(\d+)\}/g, (whole, index: string) => holes[Number(index)] ?? whole);
  }
}

/**
 * What is wrong with the table against the phrases it may hold: a key that
 * is no step expression and no phrase of an expectation, a template whose
 * numbers are out of the range of the holes or do not use each hole once.
 */
export function checkTranslations(translations: Translations, phrases: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const [phrase, template] of translations.table) {
    if (!phrases.has(phrase)) problems.push(`${TRANSLATIONS_FILE}: "${phrase}" is no step expression of ${STEPS_DIRECTORY} and no phrase of an expectation`);
    const holes = holesOf(phrase).length;
    const used = [...template.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
    const outside = used.filter((index) => index >= holes);
    if (outside.length > 0) problems.push(`${TRANSLATIONS_FILE}: "${phrase}" has ${holes} holes, but its Japanese uses {${outside.join('}, {')}}`);
    for (let index = 0; index < holes; index += 1) {
      const count = used.filter((value) => value === index).length;
      if (count !== 1) problems.push(`${TRANSLATIONS_FILE}: "${phrase}" uses its hole {${index}} ${count} times in its Japanese (once is right)`);
    }
  }
  return problems;
}

/** A kind of keyword, as the dialects of @cucumber/gherkin name it. */
type KeywordKind = 'feature' | 'background' | 'scenario' | 'scenarioOutline' | 'examples' | 'rule' | 'given' | 'when' | 'then' | 'and' | 'but';

/** The kinds of the keywords of Gherkin, by the English keyword. */
const KEYWORD_KINDS: Readonly<Record<string, KeywordKind>> = {
  Feature: 'feature',
  Background: 'background',
  Scenario: 'scenario',
  Example: 'scenario',
  'Scenario Outline': 'scenarioOutline',
  'Scenario Template': 'scenarioOutline',
  Examples: 'examples',
  Rule: 'rule',
  Given: 'given',
  When: 'when',
  Then: 'then',
  And: 'and',
  But: 'but',
};

/** The one Japanese keyword of a kind the page shows, where the dictionary has several (`機能`, not `フィーチャ`). */
const PREFERRED: Readonly<Partial<Record<KeywordKind, string>>> = { feature: '機能', and: 'かつ', but: 'しかし', examples: '例', scenarioOutline: 'シナリオアウトライン' };

/** The Japanese of an English keyword of Gherkin (`Given` → `前提`), from the dictionary of @cucumber/gherkin; the keyword as it is when it has none. */
export function japaneseKeyword(keyword: string): string {
  const english = keyword.trim();
  const kind = KEYWORD_KINDS[english];
  if (kind === undefined) return english;
  const dialect = dialects['ja'] as unknown as Record<KeywordKind, readonly string[]> | undefined;
  const words = (dialect?.[kind] ?? []).map((word) => word.trim()).filter((word) => word !== '*' && word !== '');
  const preferred = PREFERRED[kind];
  return preferred !== undefined && words.includes(preferred) ? preferred : (words[0] ?? english);
}
