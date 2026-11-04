import { randomUUID } from 'node:crypto';

const SUFFIX_LENGTH = 13;

/** The rule behind the `namePrefix` parameter of the template. */
export function validateNamePrefix(value: string): string | undefined {
  return /^[a-z][a-z0-9-]{1,9}[a-z0-9]$/.test(value)
    ? undefined
    : 'Use 3 to 11 lowercase letters, digits or hyphens, starting with a letter and not ending with a hyphen.';
}

/** The rules of Azure for a resource group name that matter here: 1 to 90 characters, not ending with a period. */
export function validateResourceGroupName(value: string): string | undefined {
  return /^[\w.()-]{1,90}$/.test(value) && !value.endsWith('.')
    ? undefined
    : 'Use 1 to 90 letters, digits, underscores, hyphens, periods or parentheses; the name must not end with a period.';
}

/**
 * The `uniqueSuffix` parameter of the template, drawn anew for every lake by the rule of the template's default: the
 * first 13 hex digits of a random GUID without hyphens. aantje draws it itself, so that it knows the names before it
 * deploys and can ask Azure whether they are free. Every run gets new names, so the same answers create a second lake.
 */
export function uniqueSuffix(guid: string = randomUUID()): string {
  return guid.replaceAll('-', '').toLowerCase().slice(0, SUFFIX_LENGTH);
}

/** The names the template derives from the prefix and the suffix. */
export function resourceNames(
  namePrefix: string,
  suffix: string,
): { readonly server: string; readonly storageAccount: string } {
  return {
    server: `${namePrefix}-${suffix.slice(0, 13)}-pg`,
    storageAccount: `${namePrefix.replaceAll('-', '')}${suffix}`.slice(0, 24),
  };
}
