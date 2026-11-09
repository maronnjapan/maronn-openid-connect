/** The Istanbul coverage map of the raw V8 counts of one target (<reports>/v8/<target>). */
export declare function coverageOf(directory: string, root?: string): Promise<{ files(): string[] }>;

/** Write <reports>/coverage/e2e/<target>/lcov.info from the raw counts of a target; the number of files in it. */
export declare function writeLcov(options: { target: string; reports?: string; root?: string }): Promise<number>;
