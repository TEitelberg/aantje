// The questions of the SQL editor before a run changes the lake: an UPDATE or DELETE without WHERE, and the commit
// message of the snapshots. They guard against mistakes and record why; what a user may change is decided by the
// catalog database and the storage. The session asks them through the hooks of `RunOptions`, so a read-only session
// and a run of the MCP tools never get here.
import type { ConnectionProfile } from '../connections/profile';
import { commitAuthorOf } from './commit-message';
import type { RunOptions, SqlSession } from './session';
import type { UnfilteredWrite } from './statement-kind';

/** An UPDATE or DELETE without WHERE as the question shows it. */
export interface UnfilteredQuestion extends UnfilteredWrite {
  /** The rows of its table, undefined when the count took too long. */
  readonly rows: number | undefined;
  /** The statements of the run that ran before it. */
  readonly ran: number;
}

/** `session`: run it and every further one of this session without asking. */
export type UnfilteredAnswer = 'run' | 'session' | 'cancel';

export interface GuardUi {
  /** The modal question before an UPDATE or DELETE without WHERE; without it, nothing is asked. */
  confirmUnfilteredWrite?(question: UnfilteredQuestion): Promise<UnfilteredAnswer>;
  /**
   * The commit message of a run, empty by default, with the last messages of the connection to pick from: the text
   * (empty for none), or undefined when cancelled. Without it, nothing is asked.
   */
  askCommitMessage?(recent: readonly string[]): Promise<string | undefined>;
}

/** The settings of the questions, read at every run. */
export interface RunSettings {
  /** `aantje.sql.confirmUnfilteredWrites`. */
  readonly confirmUnfilteredWrites: boolean;
  /** `aantje.sql.askCommitMessage`. */
  readonly askCommitMessage: boolean;
  /** `aantje.commitAuthor`; empty means the user of the connection. */
  readonly commitAuthor: string;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  confirmUnfilteredWrites: true,
  askCommitMessage: true,
  commitAuthor: '',
};

/** The settings from the configuration section `aantje`; anything but `false` keeps a question on. */
export function runSettingsOf(read: (key: string) => unknown): RunSettings {
  const author = read('commitAuthor');
  return {
    confirmUnfilteredWrites: read('sql.confirmUnfilteredWrites') !== false,
    askCommitMessage: read('sql.askCommitMessage') !== false,
    commitAuthor: typeof author === 'string' ? author : '',
  };
}

/** The last commit messages per connection (the Query History keeps them). */
export interface CommitMessageStore {
  recentMessages(connectionId: string): readonly string[];
  rememberMessage(connectionId: string, message: string): Promise<void>;
}

interface GuardPorts {
  readonly ui: GuardUi;
  readonly settings: RunSettings;
  readonly session: Pick<SqlSession, 'mode'>;
  readonly profile: ConnectionProfile;
  readonly messages: CommitMessageStore | undefined;
  /** False for a run that changes no lake whatever its statements say (Run to File): no commit message. */
  readonly commits: boolean;
  /** Aborted by a Cancel of the run; a guard that cancels aborts it too, so that the run ends as cancelled. */
  readonly control: AbortController;
  /** "Run Anyway for This Session" was chosen in this session. */
  readonly confirmed: { value: boolean };
}

/** The hooks of a run: none in a read-only session; each only with its setting on and its question in the UI. */
export function runGuards(ports: GuardPorts): Pick<RunOptions, 'confirmUnfiltered' | 'commitMessage'> {
  if (ports.session.mode === 'read-only') return {};
  return { ...unfilteredGuard(ports), ...commitMessageGuard(ports) };
}

function unfilteredGuard({
  ui,
  settings,
  control,
  confirmed,
}: GuardPorts): Pick<RunOptions, 'confirmUnfiltered'> {
  if (!settings.confirmUnfilteredWrites || !ui.confirmUnfilteredWrite) return {};
  const ask = ui.confirmUnfilteredWrite.bind(ui);
  return {
    confirmUnfiltered: async (write, count) => {
      if (confirmed.value) return true;
      const rows = await count();
      if (control.signal.aborted) return false;
      const answer = await ask({ ...write, rows });
      if (answer === 'session') confirmed.value = true;
      if (answer === 'cancel') control.abort();
      return answer !== 'cancel';
    },
  };
}

function commitMessageGuard({
  commits,
  ui,
  settings,
  profile,
  messages,
  control,
}: GuardPorts): Pick<RunOptions, 'commitMessage'> {
  if (!commits || !settings.askCommitMessage || !ui.askCommitMessage) return {};
  const ask = ui.askCommitMessage.bind(ui);
  return {
    commitMessage: async () => {
      const answer = await ask(messages?.recentMessages(profile.id) ?? []);
      if (answer === undefined) {
        control.abort();
        return undefined;
      }
      const message = answer.trim();
      if (message === '') return null;
      await messages?.rememberMessage(profile.id, message);
      return { author: commitAuthorOf(settings.commitAuthor, profile), message };
    },
  };
}
