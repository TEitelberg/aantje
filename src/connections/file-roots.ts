import type { ConnectionProfile } from './profile';

// The question of Edit Connection for the roots of the Files folder (`fileRoots`). A new connection starts with the
// default root, the bucket, container or folder of its data path; the roots are asked when it is edited. The answer is
// one line: the roots separated by semicolons.

/** The question as the wizard runs it. */
export interface FileRootsStep {
  readonly field: 'fileRoots';
  readonly prompt: string;
  readonly validate: (value: string) => string | undefined;
}

/** Splits the answer into roots: blanks around each are dropped, empty parts left out. */
function splitFileRoots(answer: string): string[] {
  return answer
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// A root with a semicolon cannot be written in the one line of the question; such roots stay as they are.
function keptRoots(existing: ConnectionProfile | undefined): readonly string[] | undefined {
  return existing?.kind !== 'quack' && existing?.fileRoots?.some((root) => root.includes(';'))
    ? existing.fileRoots
    : undefined;
}

/** A path of a storage holds no control character. */
function validateFileRoots(value: string): string | undefined {
  // oxlint-disable-next-line no-control-regex -- the check is for control characters
  return /[\x00-\x1f\x7f]/.test(value) ? 'A root must not contain control characters.' : undefined;
}

/** The prefilled answer: the roots of the profile, separated by semicolons. */
export function fileRootsAnswer(existing: ConnectionProfile | undefined): string {
  return existing === undefined || existing.kind === 'quack' ? '' : (existing.fileRoots ?? []).join('; ');
}

/** The question, when a connection that can have roots is edited. */
export function fileRootsSteps(existing: ConnectionProfile | undefined): FileRootsStep[] {
  if (existing === undefined || existing.kind === 'quack' || keptRoots(existing) !== undefined) {
    return [];
  }
  return [
    {
      field: 'fileRoots',
      prompt:
        'Roots of the Files folder: paths on the storage of the lake, separated by semicolons. Leave empty for the bucket, container or folder of the data path.',
      validate: validateFileRoots,
    },
  ];
}

/** The `fileRoots` of the edited profile: from the answer, or kept when the question was not asked. */
export function fileRootsOf(
  existing: ConnectionProfile | undefined,
  answer: string,
): { fileRoots?: readonly string[] } {
  const roots = keptRoots(existing) ?? splitFileRoots(answer);
  return roots.length === 0 ? {} : { fileRoots: roots };
}
