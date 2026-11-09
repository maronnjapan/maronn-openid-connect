/**
 * The test cases of a feature file (tests/features), read with the parser of
 * @cucumber/gherkin as their structure: a scenario is one case, an outline
 * one case a row of its examples (the id of the outline and the number of the
 * row from 1).
 *
 * Its tags say what the case is (design §3): `@id:` its id, `@endpoint:`
 * `@function:` `@scenario:` what it tests (the tags of the feature apply to
 * its scenarios), `@spec:` the sections it cites (`@spec:RFC6749-5.2` →
 * `RFC 6749 §5.2`), `@boundary` `@auth` ... its aspects, and `@hono`
 * `@nextjs` (in the process) and `@http` (a running OP) where it runs. The
 * `ja:` line under a `Feature:` or a `Scenario:` (Gherkin's free
 * description) is its Japanese name. Its `When` steps are its requests and
 * its `Then` steps what it expects.
 */
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator, type Examples, type Scenario, type Step, type Tag } from '@cucumber/messages';
import type { FeatureStep } from './model.js';

/** A case of a feature file before the catalog joins it to the map. */
export interface FeatureTest {
  /** The `@id:` of the scenario, numbered for a row of an outline; undefined when the scenario has none (the lint fails on it). */
  id?: string;
  /** The id of the outline a row belongs to, and the number of the row from 1. */
  outline?: { id?: string; row: number };
  title: string;
  ja?: string;
  /** The feature, and the outline of a row. */
  path: string[];
  featureJa?: string;
  lines: [number, number];
  tags: string[];
  steps: FeatureStep[];
  /** The values of the row of an outline, by column. */
  example?: Record<string, string>;
}

/** What the tags of a case say. */
export interface FeatureTags {
  features?: string[];
  endpoints: string[];
  functions: string[];
  scenarios: string[];
  spec: string[];
  aspects: string[];
  targets: Array<'hono' | 'nextjs' | 'http'>;
}

/** `RFC6749-5.2` → `RFC 6749 §5.2`, `OAuth2.1-2.3` → `OAuth 2.1 §2.3`, `OIDC-Core-11` → `OIDC Core 1.0 §11`. */
export function specOfTag(value: string): string {
  const match = /^(.*?)-(\d+(?:\.\d+)*)$/.exec(value);
  const document = (match?.[1] ?? value)
    .replace(/^RFC(\d{4})$/i, 'RFC $1')
    .replace(/^OAuth(\d\.\d)$/i, 'OAuth $1')
    .replace(/^OIDC-?Core(?:-?1\.0)?$/i, 'OIDC Core 1.0')
    .replace(/^OIDC-?Discovery(?:-?1\.0)?$/i, 'OIDC Discovery 1.0')
    .replace(/-/g, ' ');
  return match === null ? document : `${document} §${match[2]}`;
}

/** The tags of a case read (see the module comment); `@auth` is the tag of the authentication aspect. */
export function readFeatureTags(tags: readonly string[]): FeatureTags {
  const read: FeatureTags = { endpoints: [], functions: [], scenarios: [], spec: [], aspects: [], targets: [] };
  for (const raw of tags) {
    const tag = raw.replace(/^@/, '');
    const colon = tag.indexOf(':');
    const [name, value] = colon === -1 ? [tag, ''] : [tag.slice(0, colon), tag.slice(colon + 1)];
    if (name === 'feature') read.features = [...(read.features ?? []), ...value.split(',')];
    else if (name === 'endpoint') read.endpoints.push(value);
    else if (name === 'function') read.functions.push(value);
    else if (name === 'scenario') read.scenarios.push(value);
    else if (name === 'spec') read.spec.push(specOfTag(value));
    else if (name === 'id') continue;
    else if (name === 'hono' || name === 'nextjs' || name === 'http') read.targets.push(name);
    else if (colon === -1) read.aspects.push(name);
  }
  return read;
}

/** The `ja:` line of a description (Gherkin's free text under a keyword line). */
function japaneseOf(description: string | undefined): string | undefined {
  const line = (description ?? '').split('\n').map((text) => text.trim()).find((text) => /^ja:/.test(text));
  return line === undefined ? undefined : line.replace(/^ja:\s*/, '').trim() || undefined;
}

/** A step of a scenario with the values of a row of an outline put in for its `<column>`s. */
function stepOf(step: Step, previous: FeatureStep['type'] | undefined, row: Record<string, string> | undefined): FeatureStep {
  const fill = (text: string) => (row === undefined ? text : text.replace(/<([^<>]+)>/g, (whole, name: string) => row[name] ?? whole));
  const kind = step.keywordType;
  const type: FeatureStep['type'] = kind === 'Context' ? 'context' : kind === 'Action' ? 'action' : kind === 'Outcome' ? 'outcome' : kind === 'Conjunction' ? (previous ?? 'unknown') : 'unknown';
  const table = step.dataTable?.rows.map((tableRow) => tableRow.cells.map((cell) => fill(cell.value)));
  return { keyword: step.keyword, type, text: fill(step.text), ...(table === undefined ? {} : { table }), line: step.location.line };
}

/** The steps of a background and a scenario, the kind of an `And` taken from the step before. */
function stepsOf(steps: readonly Step[], row?: Record<string, string>): FeatureStep[] {
  const read: FeatureStep[] = [];
  let previous: FeatureStep['type'] | undefined;
  for (const step of steps) {
    const next = stepOf(step, previous, row);
    read.push(next);
    previous = next.type;
  }
  return read;
}

const tagNames = (tags: readonly Tag[]) => tags.map((tag) => tag.name);

/** The id of the `@id:` tag among some tags. */
function idOf(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith('@id:'))?.slice('@id:'.length);
}

/** The cases of a feature file (see the module comment); the parse error of a broken file is thrown. */
export function readFeatureTests(text: string): FeatureTest[] {
  const parser = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher());
  const document = parser.parse(text);
  const feature = document.feature;
  if (feature === undefined) return [];
  const featureTags = tagNames(feature.tags);
  const featureJa = japaneseOf(feature.description);
  const tests: FeatureTest[] = [];
  const lastLine = text.split('\n').length;

  const visit = (children: typeof feature.children, inheritedTags: string[], background: Step[]) => {
    let own = background;
    const scenarios = children.filter((child) => child.scenario !== undefined).map((child) => child.scenario as Scenario);
    const ends = scenarios.map((_scenario, index) => (scenarios[index + 1]?.location.line ?? lastLine + 1) - 1);
    for (const child of children) {
      if (child.background !== undefined) own = [...background, ...child.background.steps];
      if (child.rule !== undefined) visit(child.rule.children, [...inheritedTags, ...tagNames(child.rule.tags)], own);
      const scenario = child.scenario;
      if (scenario === undefined) continue;
      const tags = [...inheritedTags, ...tagNames(scenario.tags)];
      const end = ends[scenarios.indexOf(scenario)] ?? scenario.location.line;
      const ja = japaneseOf(scenario.description);
      const base = { path: [feature.name], ...(featureJa === undefined ? {} : { featureJa }) };
      if (scenario.examples.length === 0) {
        const id = idOf(tags);
        tests.push({ ...(id === undefined ? {} : { id }), title: scenario.name, ...(ja === undefined ? {} : { ja }), ...base, lines: [scenario.location.line, end], tags, steps: stepsOf([...own, ...scenario.steps]) });
        continue;
      }
      let row = 0;
      for (const examples of scenario.examples as Examples[]) {
        const header = examples.tableHeader?.cells.map((cell) => cell.value) ?? [];
        const exampleTags = [...tags, ...tagNames(examples.tags)];
        for (const body of examples.tableBody) {
          row += 1;
          const values = Object.fromEntries(header.map((name, index) => [name, body.cells[index]?.value ?? '']));
          const fill = (value: string) => value.replace(/<([^<>]+)>/g, (whole, name: string) => values[name] ?? whole);
          const outlineId = idOf(exampleTags);
          tests.push({
            ...(outlineId === undefined ? {} : { id: `${outlineId}-${row}` }),
            outline: { ...(outlineId === undefined ? {} : { id: outlineId }), row },
            title: fill(scenario.name),
            ...(ja === undefined ? {} : { ja: fill(ja) }),
            ...base,
            path: [feature.name, scenario.name],
            lines: [body.location.line, body.location.line],
            tags: exampleTags,
            steps: stepsOf([...own, ...scenario.steps], values),
            example: values,
          });
        }
      }
    }
  };
  visit(feature.children, featureTags, []);
  return tests;
}
