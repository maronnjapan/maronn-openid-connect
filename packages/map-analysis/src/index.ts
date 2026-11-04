/**
 * The analysis behind the OIDC Provider Map (apps/map): read every function
 * of the catalog and every endpoint body as a flow tree with the TypeScript
 * compiler, diff the trees of a pull request, compute where its changes take
 * effect, read its change notes, and write the data the page shows
 * (model.ts).
 */
export { buildMap, plain, type BuildOptions, type BuildResult } from './build.js';
export { changesMarkdown, changeTargets, collectChanges, diffLines, hunksOf, KIND_ORDER, KIND_WORDS, parseNameStatus, pullRequestOf, targetLabels, touchedLines, type ChangeResult } from './changes.js';
export { checkMap, uncoveredLines, type CheckResult, type MapMetrics } from './check.js';
export { countWords, diffTrees, expressionChanges, nodeWords, normalCode, placeHunks } from './diff.js';
export { noteName, writeDraft, type DraftOptions, type DraftResult } from './draft.js';
export { escapingFailures } from './failures.js';
export { CallGraph, catcherIn, reachOf, rootOf, type EndpointRoot, type ReachOptions, type ReachTarget } from './impact.js';
export { attachNotes, draftHeading, draftSections, isNote, NOTES_DIRECTORY, parseNote, referencesOf, resolveReference, withoutComments } from './notes.js';
export { readRepository, type Repository } from './repository.js';
export { frameSelections, inFrame, wayTo } from './selections.js';
export { buildTree, ends, nodesOf } from './tree.js';
export type * from './model.js';
