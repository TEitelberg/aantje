export interface PackageNotice {
  name: string;
  version: string;
  license: string;
  source: string;
  text: string | undefined;
}

export function packageDirs(sources: readonly string[], baseDir: string): string[];
export function describePackage(dir: string): PackageNotice;
export function renderNotices(packages: readonly PackageNotice[]): string;
export function writeNotices(options: { mapFiles: readonly string[]; outFile: string }): void;
