import { describe, expect, it } from 'vitest';
import { failureKind } from '../../src/health/deep-checks';

describe('what a failed footer read means for the deep check', () => {
  it.each([
    ['The engine is still busy with a statement that exceeded its time limit.', 'busy'],
    ['IO Error: HTTP GET error on the url (HTTP 403 Forbidden)\n\nAccessDenied', 'store'],
    ['IO Error: SignatureDoesNotMatch', 'store'],
    ['IO Error: Could not resolve hostname', 'store'],
    ['IO Error: Could not connect to server', 'store'],
    ['IO Error: SSL connect error', 'store'],
    ['IO Error: HTTP GET error on the url (HTTP 404 Not Found)', 'gone'],
    ['IO Error: NoSuchKey', 'gone'],
    ['IO Error: No files found that match the pattern "x.parquet"', 'gone'],
    ['Invalid Input Error: No magic bytes found at end of file', 'unreadable'],
  ] as const)('classifies "%s" as %s', (text, kind) => {
    expect(failureKind(text)).toBe(kind);
  });

  it('prefers the file being gone over a refusal when the answer is a 404', () => {
    expect(failureKind('Could not connect: HTTP 404 and AccessDenied')).toBe('gone');
  });
});
