/** Data files below this size count as small files. */
export const SMALL_FILE_BYTES = 16 * 1024 * 1024;

/** A table is made of small files with at least `minFiles` files of which at least `ratio` are small. */
export const SMALL_FILES = { minFiles: 5, ratio: 0.5 } as const;

/** The rule of `SMALL_FILES`, for the Statistics and Storage reports and the advisor alike. */
export const hasManySmallFiles = ({
  files,
  smallFiles,
}: {
  readonly files: number;
  readonly smallFiles: number;
}): boolean => files >= SMALL_FILES.minFiles && smallFiles / files >= SMALL_FILES.ratio;

/** The rule in words: `at least 5 data files, 50 % or more of them`. */
export const manySmallFilesText = (): string =>
  `at least ${SMALL_FILES.minFiles} data files, ${SMALL_FILES.ratio * 100} % or more of them`;

/** More snapshots than this gets the health check's hint to expire some. */
export const MANY_SNAPSHOTS = 10_000;

/** A table with more inlined rows than this gets the hint of the health check and the advisor to flush them to Parquet. */
export const LARGE_INLINED_ROWS = 10_000;

/** Files scheduled for deletion are overdue when the oldest waits longer than this many days. */
export const CLEANUP_OVERDUE_DAYS = 7;

/** Default count of newest snapshots `snapshotActivity` reads. */
export const ACTIVITY_LIMIT = 500;
