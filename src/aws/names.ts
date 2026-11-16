import { randomBytes } from 'node:crypto';

/** The rule of the template's LakeName: it goes into the stack and bucket names and the tag `aantje:lake`. */
const LAKE_NAME = /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/;

export function validateLakeName(value: string): string | undefined {
  return LAKE_NAME.test(value)
    ? undefined
    : 'Use 3 to 24 lower-case letters, digits and hyphens, starting with a letter and not ending with a hyphen.';
}

/** 12 hex digits, new for every run: the stack and the bucket of a lake share them. */
export function uniqueSuffix(): string {
  return randomBytes(6).toString('hex');
}

/** The stack and the bucket of a lake: `aantje-<name>-<suffix>` both (a bucket name is global, so the suffix). */
export function lakeNames(
  lakeName: string,
  suffix: string,
): { readonly stack: string; readonly bucket: string } {
  const name = `aantje-${lakeName}-${suffix}`;
  return { stack: name, bucket: name };
}
