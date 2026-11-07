/**
 * The test catalog of the OIDC Provider (apps/map/docs/design-test-catalog.md):
 * read every test case of the repository as a card joined to the function
 * catalog of the map, take in the results and the reach of a run, diff the
 * catalog of a pull request, and write the data the tests viewer (apps/tests)
 * shows (model.ts).
 */
export { parseAspects, readAspects, aspectsOf, ASPECTS_FILE, type AspectTable } from './aspects.js';
export { buildTests, codeOfFrame, readBaseCatalog, readTables, shownFiles, stepBlocks, withRun, type TestBuildOptions } from './build.js';
export { EndpointIndex, helperResolver, outcomeOf, readCatalog, scenarioHelpers, stepDefinitionCode, stepDefinitionLines, stepOutcome, type CatalogInput, type CatalogResult, type StepDefinitionCode } from './catalog.js';
export { changesOf, diffCatalogs, expectationOverlap, relatedTests } from './diff.js';
export { isTestSupportPath, listFiles, supportFiles, testFileOf, testFiles, type TestFile } from './discover.js';
export { draftTests, mapDataOf } from './draft.js';
export { exampleTestId, fileTestId, hashedTestId } from './id.js';
export { countTests, joinTests, reachableFrames, type Joined } from './join.js';
export { fixedIds, lintTests, type TestLintViolation } from './lint.js';
export { testsMarkdown } from './markdown.js';
export { readRun, type JoinedRun } from './run.js';
export { checkTranslations, japaneseKeyword, Translations, Vocabulary } from './vocabulary.js';
export { expectationPhrases, sayExpectation } from './words.js';
export type * from './model.js';
