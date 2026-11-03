/**
 * The TypeScript compiler the analysis reads the code with: the API of
 * TypeScript 7 (`typescript/unstable/sync`), which runs the native compiler
 * in a child process and answers over a pipe, and its syntax tree
 * (`typescript/unstable/ast`).
 *
 * The API is marked unstable, so everything the analysis takes from it goes
 * through this module: the rest of the package sees the syntax tree and a
 * handful of questions (the symbol a name refers to, the type of an
 * expression, the members of a type).
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { API, SymbolFlags, type Checker, type Project, type Symbol as TsSymbol, type Type as TsType } from 'typescript/unstable/sync';
import { SyntaxKind, getLeadingCommentRanges, type Node, type SourceFile } from 'typescript/unstable/ast';

export { SyntaxKind, SymbolFlags, getLeadingCommentRanges };
export type { Checker, Node, Project, SourceFile, TsSymbol, TsType };

/**
 * The files of a revision that differ from the working tree: path (absolute)
 * → its text in the revision, or null when the revision does not have it.
 */
export type Overlay = ReadonlyMap<string, string | null>;

/** The virtual files the API reads before the disk: the tsconfig overlays and, for a revision, the files of that revision. */
function fileSystem(virtual: ReadonlyMap<string, string>, overlay: Overlay | undefined) {
  /** The directories the overlay adds files to or removes them from, with the names it changes. */
  const directories = new Map<string, { add: Set<string>; remove: Set<string> }>();
  const touch = (path: string, present: boolean) => {
    const directory = dirname(path);
    const entry = directories.get(directory) ?? { add: new Set<string>(), remove: new Set<string>() };
    const name = path.slice(directory.length + 1);
    if (present) entry.add.add(name);
    else entry.remove.add(name);
    directories.set(directory, entry);
  };
  for (const path of virtual.keys()) touch(path, true);
  for (const [path, text] of overlay ?? []) touch(path, text !== null);
  return {
    readFile: (name: string): string | null | undefined => {
      const own = virtual.get(name);
      if (own !== undefined) return own;
      if (overlay?.has(name) === true) return overlay.get(name) ?? null;
      return undefined;
    },
    fileExists: (name: string): boolean | undefined => {
      if (virtual.has(name)) return true;
      if (overlay?.has(name) === true) return overlay.get(name) !== null;
      return undefined;
    },
    getAccessibleEntries: (name: string): { files: string[]; directories: string[] } | undefined => {
      const change = directories.get(name);
      if (change === undefined) return undefined;
      let files: string[] = [];
      let subdirectories: string[] = [];
      try {
        for (const entry of readdirSync(name, { withFileTypes: true })) {
          if (entry.isDirectory()) subdirectories.push(entry.name);
          else if (entry.isFile()) files.push(entry.name);
          else if (entry.isSymbolicLink()) {
            const stat = statSync(join(name, entry.name), { throwIfNoEntry: false });
            if (stat?.isDirectory() === true) subdirectories.push(entry.name);
            else if (stat?.isFile() === true) files.push(entry.name);
          }
        }
      } catch {
        // A directory only the revision has.
      }
      files = files.filter((file) => !change.remove.has(file));
      for (const file of change.add) if (!files.includes(file)) files.push(file);
      subdirectories = [...new Set(subdirectories)];
      return { files, directories: subdirectories };
    },
    directoryExists: (name: string): boolean | undefined => (directories.has(name) ? true : undefined),
  };
}

/** A running compiler with some projects open: the working tree, or a revision laid over it. */
export class Compiler {
  private readonly api: API;
  private readonly projects = new Map<string, Project>();

  /**
   * @param repository the root of the repository (the working directory of the compiler)
   * @param configs the tsconfig files to open: path → text (each a virtual file over the disk)
   * @param overlay the files of a revision that differ from the working tree
   */
  constructor(repository: string, configs: ReadonlyMap<string, string>, overlay?: Overlay) {
    this.api = new API({ cwd: repository, fs: fileSystem(configs, overlay) });
    const snapshot = this.api.updateSnapshot({ openProjects: [...configs.keys()] });
    for (const project of snapshot.getProjects()) this.projects.set(project.configFileName, project);
  }

  /** The project of a tsconfig opened at the start. */
  project(config: string): Project {
    const project = this.projects.get(config);
    if (project === undefined) throw new Error(`The compiler has no project ${config}`);
    return project;
  }

  close(): void {
    this.api.close();
  }
}

/** Whether a symbol is an alias (an import, a re-export) of another. */
export function isAlias(symbol: TsSymbol): boolean {
  return (symbol.flags & SymbolFlags.Alias) !== 0;
}
