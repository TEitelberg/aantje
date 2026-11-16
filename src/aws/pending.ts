import type { SecretsPort } from '../connections/ports';
import { isObject } from '../guards';
import type { KeyValueStore } from '../azure/registry';

/** A stack that Create AWS DuckLake started and has not turned into a connection yet. */
export interface PendingAwsLake {
  readonly account: string;
  readonly region: string;
  /** The profile of the AWS configuration; undefined: the credentials of the environment. */
  readonly awsProfile?: string;
  readonly stackId: string;
  readonly stackName: string;
  readonly lakeName: string;
  readonly bucket: string;
  /** `iam`: the role ducklake_iam is still to be created with the kept password, which then goes. */
  readonly authentication?: 'iam';
}

/** What to tell the user at start when stacks are still pending; undefined when nothing is. */
export function pendingAwsNotice(lakes: readonly PendingAwsLake[]): string | undefined {
  if (lakes.length === 0) return undefined;
  const names = lakes.map(({ lakeName, region }) => `"${lakeName}" (${region})`);
  return `The creation of ${lakes.length === 1 ? 'an AWS DuckLake was' : 'AWS DuckLakes were'} interrupted: ${names.join(', ')}. CloudFormation goes on without the editor. Finish it to add the connection. If the stack failed, delete it in the CloudFormation console; what it created costs money until then.`;
}

const KEY = 'aantje.pendingAwsLakes';
const passwordKey = (stackId: string): string => `aantje.pendingAwsLake.${stackId}`;

/**
 * What only aantje knows of a stack it started, kept from before the start until the lake is a connection: the names in
 * the global state, the generated password in the secret storage. Keyed by the stack id.
 */
export class PendingAwsLakes {
  constructor(
    private readonly state: KeyValueStore,
    private readonly secrets: SecretsPort,
    /** Called with every password read or written, so the log redactor knows it. */
    private readonly registerSecret: (value: string) => void = () => undefined,
  ) {}

  list(): PendingAwsLake[] {
    return Object.values(this.all()).filter(isPendingAwsLake);
  }

  /** The password first, so that a record never names a password that was not kept. */
  async add(lake: PendingAwsLake, password: string): Promise<void> {
    this.registerSecret(password);
    await this.secrets.set(passwordKey(lake.stackId), password);
    await this.state.update(KEY, { ...this.all(), [lake.stackId]: lake });
  }

  async password(lake: PendingAwsLake): Promise<string | undefined> {
    const password = await this.secrets.get(passwordKey(lake.stackId));
    if (password) this.registerSecret(password);
    return password;
  }

  async remove(stackId: string): Promise<void> {
    const { [stackId]: _removed, ...rest } = this.all();
    await this.state.update(KEY, rest);
    await this.secrets.delete(passwordKey(stackId));
  }

  private all(): Record<string, unknown> {
    const value = this.state.get(KEY);
    return isObject(value) ? value : {};
  }
}

function isPendingAwsLake(value: unknown): value is PendingAwsLake {
  return (
    isObject(value) &&
    ['account', 'region', 'stackId', 'stackName', 'lakeName', 'bucket'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    (value.awsProfile === undefined || typeof value.awsProfile === 'string')
  );
}
