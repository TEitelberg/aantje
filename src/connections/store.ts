import { AantjeError } from '../errors';
import type { SecretsPort, SettingsPort } from './ports';
import type { ConnectionProfile } from './profile';
import {
  boundPassword,
  isNameTaken,
  newProfileId,
  parseEntries,
  parseProfiles,
  passwordSecretKey,
  passwordSecretValue,
  signsInWithEntra,
  toSettingEntry,
  usesSecret,
} from './profile';

/** Profiles in `aantje.connections` and their passwords or tokens in the secret storage; a write touches only its own entry. */
export class ConnectionStore {
  constructor(
    private readonly settings: SettingsPort,
    private readonly secrets: SecretsPort,
    /** Called with every password read or written, so the log redactor knows it. */
    private readonly registerSecret: (value: string) => void = () => undefined,
  ) {}

  list(): ConnectionProfile[] {
    return parseProfiles(this.settings.read()).profiles;
  }

  problems(): string[] {
    return parseProfiles(this.settings.read()).problems;
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((profile) => profile.id === id);
  }

  newId(name: string): string {
    return newProfileId(name, this.rawEntries());
  }

  /**
   * The stored password (or Quack token) for `profile`, but only when it was stored for this exact server
   * (`connectionTarget`). A password stored for another target (the host was edited, or a new entry reused an old one's
   * id) is not returned, so it is never sent to a server it was not given for. The caller passes the profile it is
   * about to connect, which in the wizard is the edited one, not the one still in the settings.
   */
  async password(profile: ConnectionProfile): Promise<string | undefined> {
    if (!usesSecret(profile)) {
      return undefined;
    }
    const raw = await this.secrets.get(passwordSecretKey(profile.id));
    const password = raw === undefined ? undefined : boundPassword(raw, profile);
    this.registerPassword(password);
    return password;
  }

  /** Tells the log redactor about a password in use but not yet stored; empty values are ignored. */
  registerPassword(password: string | undefined): void {
    if (password) {
      this.registerSecret(password);
    }
  }

  /** Appends the profile; without a password, deletes a leftover secret of an earlier profile with that id. */
  async add(profile: ConnectionProfile, password?: string): Promise<void> {
    const entries = this.rawEntries();
    const profiles = parseProfiles(entries).profiles;
    if (profiles.some(({ id }) => id === profile.id)) {
      throw new AantjeError('INVALID_PROFILE', `A connection with the id "${profile.id}" already exists.`);
    }
    requireFreeName(profile, profiles);
    await this.settings.write([...entries, toSettingEntry(profile)]);
    await this.setPassword(profile, password);
  }

  /**
   * Replaces the profile with the same id. A new password is stored; an empty password keeps the stored one only when it
   * still belongs to this server, and discards it when the target changed (the orphaned password of the old server).
   * A profile that signs in with Entra keeps no password. An unchanged profile is not rewritten.
   */
  async update(profile: ConnectionProfile, password?: string): Promise<void> {
    const { entries, profiles, index, current } = this.locate(profile.id);
    requireFreeName(profile, profiles);
    const next = toSettingEntry(profile);
    if (JSON.stringify(toSettingEntry(current)) !== JSON.stringify(next)) {
      await this.settings.write(entries.map((entry, i) => (i === index ? next : entry)));
    }
    if (password) {
      await this.setPassword(profile, password);
    } else if (signsInWithEntra(profile)) {
      // A token is fetched for every connect; the password of the earlier sign-in must not stay behind.
      await this.setPassword(profile, undefined);
    } else {
      await this.discardOrphanPassword(profile);
    }
  }

  async remove(id: string): Promise<void> {
    const { entries, index } = this.locate(id);
    await this.settings.write(entries.filter((_, i) => i !== index));
    await this.secrets.delete(passwordSecretKey(id));
  }

  private rawEntries(): unknown[] {
    const value: unknown = this.settings.read();
    if (value === undefined || value === null) {
      return [];
    }
    // Replacing a non-array would destroy what the user wrote.
    if (!Array.isArray(value)) {
      throw new AantjeError(
        'INVALID_PROFILE',
        'The setting "aantje.connections" is not an array. Fix it in the settings, then try again.',
      );
    }
    return value as unknown[];
  }

  private locate(id: string) {
    const entries = this.rawEntries();
    const parsed = parseEntries(entries);
    const index = parsed.findIndex(({ profile }) => profile?.id === id);
    const current = parsed[index]?.profile;
    if (!current) {
      throw new AantjeError('INVALID_PROFILE', `The connection "${id}" does not exist (any more).`);
    }
    return {
      entries,
      index,
      current,
      profiles: parsed.flatMap(({ profile }) => (profile ? [profile] : [])),
    };
  }

  // File profiles have no password; for Postgres and Quack, no password means none is stored. The secret carries the
  // target the password was given for (`passwordSecretValue`), so a later read can refuse to send it to another server.
  private async setPassword(profile: ConnectionProfile, password: string | undefined): Promise<void> {
    if (!usesSecret(profile)) {
      return;
    }
    if (password) {
      this.registerPassword(password);
      await this.secrets.set(passwordSecretKey(profile.id), passwordSecretValue(profile, password));
    } else {
      await this.secrets.delete(passwordSecretKey(profile.id));
    }
  }

  // Deletes a stored password that no longer belongs to the profile's server, so a re-targeted connection leaves none
  // behind. A password that still matches the target, and a profile that owns no secret, are left untouched.
  private async discardOrphanPassword(profile: ConnectionProfile): Promise<void> {
    if (!usesSecret(profile)) {
      return;
    }
    const raw = await this.secrets.get(passwordSecretKey(profile.id));
    if (raw !== undefined && boundPassword(raw, profile) === undefined) {
      await this.secrets.delete(passwordSecretKey(profile.id));
    }
  }
}

function requireFreeName(profile: ConnectionProfile, profiles: readonly ConnectionProfile[]): void {
  if (isNameTaken(profile.name, profiles, profile.id)) {
    throw new AantjeError('INVALID_PROFILE', `A connection named "${profile.name}" already exists.`);
  }
}
