/**
 * The id of a test case: the same test gets the same id in two builds, and
 * moving it to another file keeps it.
 *
 * - A scenario of a feature file is named by its `@id:` tag; a row of the
 *   examples of an outline adds its number (`token-missing-parameter-2`).
 * - A test of the code with a `// @test-id <id>` comment above it is named by
 *   that id.
 * - Any other test is named by a hash of its root (core, hono, nextjs, e2e,
 *   ...), the describe blocks it is in and its title. The root does not change
 *   when a file moves inside it, and the top describe names a function, so
 *   splitting or moving a file keeps the id; renaming the test changes it, and
 *   the diff of the tests pairs the two as a rename.
 */
import { createHash } from 'node:crypto';

/** The id of a test of the code that declares none (see the module comment). */
export function hashedTestId(root: string, path: readonly string[], title: string): string {
  return createHash('sha256').update([root, ...path, title].join('\u0000')).digest('hex').slice(0, 16);
}

/** The id of a test that is the same in two places, told apart by its file. */
export function fileTestId(root: string, file: string, path: readonly string[], title: string): string {
  return hashedTestId(root, [file, ...path], title);
}

/** The id of a row of the examples of an outline: the id of the outline and the number of the row from 1. */
export function exampleTestId(id: string, row: number): string {
  return `${id}-${row}`;
}
