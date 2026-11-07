/** The roots whose functions the function catalog reads. */
export declare const FUNCTION_ROOTS: string[];
/** Whether this process measures what each test runs (MARONN_REACH=1). */
export declare function reachEnabled(env?: Record<string, string | undefined>): boolean;
/** The repository this package is in, as an absolute path. */
export declare function repositoryRoot(): string;
/** The directory the reports are written under; none when neither MARONN_TEST_REPORTS nor MARONN_REACH=1 is set. */
export declare function reportsDirectory(env?: Record<string, string | undefined>): string | undefined;
/** The path of a file relative to the repository, with forward slashes; none outside it. */
export declare function repositoryPath(file: string, root?: string): string | undefined;
/** Whether a repository path is source code of the function catalog. */
export declare function isCatalogSource(path: string): boolean;
