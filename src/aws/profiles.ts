// The profiles of the AWS configuration that a lake can be created with: the sections of `~/.aws/config` and
// `~/.aws/credentials` (or the files that AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE name). Only names, regions
// and the kind of sign-in are read here; the SDK reads the credentials when a call needs them.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AwsProfile {
  readonly name: string;
  readonly region?: string;
  /** IAM Identity Center: `aws sso login --profile <name>` signs in. */
  readonly sso: boolean;
}

/** The sections of an INI text: `[name]` and its `key = value` lines; comments and blank lines are skipped. */
export function iniSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1] !== undefined) {
      current = new Map();
      sections.set(header[1].trim(), current);
      continue;
    }
    const pair = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (current && pair?.[1] !== undefined) current.set(pair[1].toLowerCase(), (pair[2] ?? '').trim());
  }
  return sections;
}

/**
 * The profiles of the two files: in the config file `[default]` and `[profile <name>]` (not `[sso-session ...]` or
 * `[services ...]`), in the credentials file every section. Sorted by name, `default` first.
 */
export function profilesOf(configText: string, credentialsText: string): AwsProfile[] {
  const profiles = new Map<string, { region?: string; sso: boolean }>();
  for (const [section, values] of iniSections(configText)) {
    const name = section === 'default' ? 'default' : /^profile\s+(\S+)$/.exec(section)?.[1];
    if (name === undefined) continue;
    const region = values.get('region');
    profiles.set(name, {
      ...(region ? { region } : {}),
      sso: values.has('sso_session') || values.has('sso_start_url') || values.has('sso_account_id'),
    });
  }
  for (const section of iniSections(credentialsText).keys()) {
    if (!profiles.has(section)) profiles.set(section, { sso: false });
  }
  return [...profiles]
    .map(([name, values]) => ({ name, ...values }))
    .sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)));
}

/** A variable of the environment; an empty one counts as unset. */
const variable = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name];
  return value === '' ? undefined : value;
};

/** Whether the environment holds AWS keys (`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`). */
export function environmentHasKeys(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    variable(env, 'AWS_ACCESS_KEY_ID') !== undefined && variable(env, 'AWS_SECRET_ACCESS_KEY') !== undefined
  );
}

/** The region of the environment (`AWS_REGION`, else `AWS_DEFAULT_REGION`). */
export function environmentRegion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return variable(env, 'AWS_REGION') ?? variable(env, 'AWS_DEFAULT_REGION');
}

/** Reads the profiles of this machine; a missing file counts as empty. */
export async function readAwsProfiles(env: NodeJS.ProcessEnv = process.env): Promise<AwsProfile[]> {
  const folder = join(homedir(), '.aws');
  const read = (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '');
  const [config, credentials] = await Promise.all([
    read(variable(env, 'AWS_CONFIG_FILE') ?? join(folder, 'config')),
    read(variable(env, 'AWS_SHARED_CREDENTIALS_FILE') ?? join(folder, 'credentials')),
  ]);
  return profilesOf(config, credentials);
}
