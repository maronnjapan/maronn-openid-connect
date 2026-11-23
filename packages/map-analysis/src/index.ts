/**
 * The analysis behind the OIDC Provider Map (apps/map): read every function
 * of the catalog and every endpoint body as a flow tree with the TypeScript
 * compiler, diff the trees of a pull request, compute where its changes take
 * effect, read its change notes, read what each change that reached main
 * did, and write the data the page shows (model.ts).
 */
export { buildMap, plain, removeStale, writeHashed, type BuildContext, type BuildExtension, type BuildOptions, type BuildResult } from './build.js';
export { changesMarkdown, changeTargets, collectChanges, diffLines, git, hunksOf, KIND_ORDER, KIND_WORDS, LINKS_PLACE, parseNameStatus, pullRequestOf, targetLabels, touchedLines, type ChangedFile, type ChangeResult } from './changes.js';
export { codeIndexOf } from './code-index.js';
export { changeBrief, changeNamed, changesFor, entryKey, entryOf, functionBrief, functionsNamed, keyOf, keyOfInput, listBrief, namesPull, omittedWords, placeOf, sharingNumber, unifiedHunk, type BriefMap } from './history-brief.js';
export { checkLinks, checkMap, uncoveredLines, type CheckResult, type LinkCheck, type MapMetrics } from './check.js';
export { readLinks, usesOf, type AliasCache, type LinkInput } from './symbols.js';
export { countWords, diffTrees, expressionChanges, nodeWords, normalCode, placeHunks } from './diff.js';
export { noteName, writeDraft, type DraftOptions, type DraftResult } from './draft.js';
export { escapingFailures } from './failures.js';
export { featureOfPath, sourceFeatureRanges } from './features.js';
export { heldRevision, mainRevision, originRepository, readHistory, readHistoryWithDiffs, MAX_CHANGE_DIFF_LINES, MAX_FILE_DIFF_LINES, repositoryOfRemote, type HistoryOptions, type PullRequestInfo } from './history.js';
export { CallGraph, catcherIn, reachOf, rootOf, type EndpointRoot, type ReachOptions, type ReachTarget } from './impact.js';
export { attachNotes, draftHeading, draftSections, draftTestLines, draftTestSections, isNote, NOTES_DIRECTORY, parseNote, referencesOf, resolveReference, withoutComments, type DraftTests } from './notes.js';
export { readRepository, type Repository } from './repository.js';
// The reading the test catalog (packages/test-catalog) shares with the map: the compiler, the roots, the resolution of names by the types, the syntax tree.
export { catalogModules, type EndpointSource, type FrameInfo, type Revision } from './analyze.js';
export { any, endLine, is, nameOf, startLine, stringOf, textOf, unwrap, walk } from './ast.js';
export { Resolver, type ResolverOptions } from './resolve.js';
export { isTestPath, isTestSupportPath, moduleOf, overlayConfigs, overlayOf, pathOf, readRoots, type AnalysisRoot } from './roots.js';
export { Compiler, getLeadingCommentRanges, isAlias, SyntaxKind, type Node, type Overlay, type Project, type SourceFile } from './ts.js';
export { failureSelections, frameSelections, inFrame, wayTo } from './selections.js';
export { buildTree, ends, nodesOf } from './tree.js';
// The walk of one request through a tree: plain data, shared with the page (`@maronn-openid-connect/map-analysis/walk`).
export { assumedSide, FAILS, stepsOf, walkFlow, type FlowWalk, type WalkEvent, type WalkOptions, type WalkStop } from './walk.js';
// The reading of a measured request against the trees: shared with the page too (`@maronn-openid-connect/map-analysis/observe`).
export { BOTH, FrameLocator, GOES, locate, nodeRan, placesOf, RequestRun, seenDecisions, seenSide, throughTries, type Located, type Place, type RanInFile, type RanRequest, type RunSources } from './observe.js';
export type * from './model.js';
