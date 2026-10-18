/** A file of the generated provider. */
export interface GeneratedFile {
  /** Relative path from output directory */
  path: string;
  /** File content */
  content: string;
  /**
   * The user writes this file (db/instance.ts): the CLI only creates it when it
   * does not exist yet and never overwrites it, not even with --force.
   */
  userOwned?: boolean;
}
