/**
 * The shape of the data the page reads: public/data/map.json (MapData) and
 * one file a frame under public/data/functions/ (FrameFile), which the
 * analysis (packages/map-analysis) writes; and the tests beside them
 * (tests.json, the cards under tests/, the diff of a pull request), which
 * packages/test-catalog writes. Each package's model.ts is the one
 * definition of its part.
 */
export type * from '@maronn-openid-connect/map-analysis/model';
export type * from '@maronn-openid-connect/test-catalog/model';
