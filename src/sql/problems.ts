import { compareText } from '../order';
import type { Diagnostic } from './syntax';

/** A mark of the check while typing: a syntax error, or a warning about a name that the lake certainly lacks. */
export interface Problem extends Diagnostic {
  readonly severity: 'error' | 'warning';
  /** What a quick fix can put in place of the range, the nearest first, quoted where the name needs it. */
  readonly replacements: readonly string[];
}

/** An edit that replaces the range of a problem. */
export interface QuickFix {
  readonly title: string;
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

const MAX_REPLACEMENTS = 3;

/** The quick fixes of a problem, the nearest name first. */
export function quickFixes(problem: Problem): QuickFix[] {
  const { offset, length } = problem;
  return problem.replacements.map((text) => ({ title: `Change to ${text}`, offset, length, text }));
}

/**
 * The known names nearest to `name` by edit distance, ignoring case, at most three: none differs in more than a third
 * of the letters (one for a name of two to five letters), so a name with nothing close gets none.
 */
export function nearestNames(name: string, known: Iterable<string>): string[] {
  const wanted = name.toLowerCase();
  const most = Math.max(wanted.length >= 2 ? 1 : 0, Math.floor(wanted.length / 3));
  const seen = new Set<string>();
  const close: { name: string; distance: number }[] = [];
  for (const candidate of known) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const distance = editDistance(wanted, key);
    if (distance <= most) close.push({ name: candidate, distance });
  }
  return close
    .sort((a, b) => a.distance - b.distance || compareText(a.name.toLowerCase(), b.name.toLowerCase()))
    .slice(0, MAX_REPLACEMENTS)
    .map((found) => found.name);
}

/** Insertions, deletions, substitutions and swaps of two neighbours count one each (optimal string alignment). */
function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (before[j - 2] ?? 0) + 1);
      }
      current.push(best);
    }
    before = previous;
    previous = current;
  }
  return previous[b.length] ?? 0;
}
