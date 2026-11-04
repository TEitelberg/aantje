import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { docPages, pageProblems, pagesNotInIndex } from '../support/docs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('the documentation of the project', () => {
  const pages = docPages(projectRoot);

  it('has well-formed pages: UTF-8 without BOM, LF, no damaged text, closed code blocks', () => {
    expect(pages.some((page) => page.startsWith('docs/en/'))).toBe(true);
    for (const page of pages) {
      expect(pageProblems(projectRoot, page), page).toEqual([]);
    }
  });

  it('links only to files and headings that exist (the one link check, scripts/check-docs.mjs)', () => {
    expect(checkDocs(projectRoot).status).toBe(0);
  });

  it('lists every page in the index', () => {
    expect(pagesNotInIndex(projectRoot)).toEqual([]);
  });
});

const md = (...lines: string[]): string => `${lines.join('\n')}\n`;

/** Runs the link check of the project on a tree; its problems are the indented lines of the output. */
function checkDocs(root: string): { status: number | null; output: string } {
  const script = join(projectRoot, 'scripts', 'check-docs.mjs');
  const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

const problemLines = (output: string): string[] =>
  output
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim());

describe('the documentation check on synthetic projects', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function project(files: Record<string, string | Uint8Array>): string {
    const root = mkdtempSync(join(tmpdir(), 'aantje-docs-'));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const problemsOf = (content: string | Uint8Array): string[] =>
    pageProblems(project({ 'docs/en/guide.md': content }), 'docs/en/guide.md');

  it('accepts a page with tables, nested fences and "#" lines in code', () => {
    const page = md(
      '# Guide',
      '',
      '| Name | Purpose |',
      '| ---- | ------- |',
      '| a    | b       |',
      '',
      '1. First step:',
      '',
      '   ```bash',
      '   # comment, not a heading',
      '   ```',
      '',
      '````markdown',
      '```ts',
      '```',
      '````',
    );
    expect(problemsOf(page)).toEqual([]);
  });

  it('reports a missing page, a BOM, CR line endings, bytes that are not UTF-8, damaged text and an unclosed code block', () => {
    expect(pageProblems(project({}), 'docs/en/guide.md')).toEqual(['docs/en/guide.md is missing']);
    const cases: [string, string | Uint8Array, string][] = [
      [
        'a byte order mark',
        Buffer.concat([Uint8Array.of(0xef, 0xbb, 0xbf), Buffer.from(md('# Guide'))]),
        'docs/en/guide.md starts with a byte order mark (BOM); save it as UTF-8 without BOM',
      ],
      [
        'CRLF line endings',
        md('# Guide', 'Text').replaceAll('\n', '\r\n'),
        'docs/en/guide.md uses a CR or CRLF line ending in line 1; use LF',
      ],
      [
        'bytes that are not UTF-8',
        Buffer.concat([Buffer.from(md('# Guide')), Uint8Array.of(0xe4, 0x0a)]),
        'docs/en/guide.md is not valid UTF-8',
      ],
      [
        'a double-encoded dash',
        md('# Guide', '', 'Text \xe2\u{20ac}\u{201c} here.'),
        'docs/en/guide.md contains text damaged by a wrong encoding in line 3: "Text \xe2\u{20ac}\u{201c} here."',
      ],
      [
        'a code block that is never closed',
        md('# Guide', '', '```bash', 'npm test'),
        'docs/en/guide.md opens a code block in line 3 that is never closed',
      ],
    ];
    for (const [name, content, expected] of cases) {
      expect(problemsOf(content), name).toEqual([expected]);
    }
  });

  describe('links that lead nowhere', () => {
    it('names a link within the page to a heading that does not exist', () => {
      const result = checkDocs(project({ 'README.md': md('# aantje', '', '[ok](#aantje) [bad](#nope)') }));
      expect(result.status).toBe(1);
      expect(problemLines(result.output)).toEqual([expect.stringContaining('#nope')]);
    });

    it('names every link to a missing file or heading, also a repeated heading by its number', () => {
      const result = checkDocs(
        project({
          'README.md': md('# aantje', '', '![logo](media/logo.png) [docs](docs/en/a.md#second-part)'),
          'media/logo.png': 'not a real picture',
          'docs/en/a.md': md(
            '# A',
            '',
            '[ok](b.md#deep-dive-1) [own](#second-part) [web](https://example.com/x) [mail](mailto:a@b.c)',
            '[gone](missing.md) [bad](b.md#nope) [case](B.md) `[code](nothere.md)`',
            '',
            '```md',
            '[fenced](nothere.md)',
            '```',
            '',
            '## Second part',
          ),
          'docs/en/b.md': md('# B', '', '## Deep dive', '', '## Deep dive'),
        }),
      );
      const problems = problemLines(result.output);
      expect(result.status).toBe(1);
      expect(problems).toHaveLength(3);
      for (const target of ['missing.md', '#nope', 'B.md']) {
        expect(
          problems.filter((line) => line.includes(target)),
          target,
        ).toHaveLength(1);
      }
    });
  });

  describe('the index', () => {
    it('names every page of docs/en that it does not link to', () => {
      const root = project({
        'README.md': md('# aantje'),
        'docs/en/index.md': md('# Index', '', '[A](a.md) [B](sub/b.md#top)'),
        'docs/en/a.md': md('# A'),
        'docs/en/sub/b.md': md('# B'),
        'docs/en/c.md': md('# C'),
        'docs/en/sub/d.md': md('# D'),
      });
      expect(pagesNotInIndex(root)).toEqual(['docs/en/c.md', 'docs/en/sub/d.md']);
    });
  });
});
