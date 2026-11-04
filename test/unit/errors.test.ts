import { describe, expect, it } from 'vitest';
import { AantjeError, isAantjeError, isErrnoException, messageOf, userMessageOf } from '../../src/errors';

describe('AantjeError', () => {
  it('carries code and user message (also as the Error message) and keeps the low-level failure as its cause', () => {
    const cause = new Error('password authentication failed for user "app"');
    const error = new AantjeError('AUTH_FAILED', 'Authentication failed.', { cause });

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'AantjeError',
      code: 'AUTH_FAILED',
      userMessage: 'Authentication failed.',
      message: 'Authentication failed.',
      cause,
    });
    expect(new AantjeError('ABORTED', 'The query was cancelled.').cause).toBeUndefined();
  });

  it('is recognised by isAantjeError, and nothing that only looks like one is', () => {
    expect(isAantjeError(new AantjeError('TIMEOUT', 'The query timed out.'))).toBe(true);
    for (const value of [
      new Error('boom'),
      { name: 'AantjeError', code: 'TIMEOUT', userMessage: 'x' },
      'TIMEOUT',
      null,
      undefined,
    ]) {
      expect(isAantjeError(value)).toBe(false);
    }
  });
});

describe('userMessageOf', () => {
  it('returns the user message of an AantjeError and nothing of its cause', () => {
    const error = new AantjeError('CONNECTION_FAILED', 'Cannot connect to db:5432.', {
      cause: new Error('could not connect with password hunter2'),
    });

    expect(userMessageOf(error)).toBe('Cannot connect to db:5432.');
  });

  it('reduces everything else to one generic text that leaks nothing of the thrown value', () => {
    const generic = userMessageOf(new Error('marker-7f3a'));
    const secretThings = [
      new Error('password authentication failed, password was hunter2'),
      new TypeError('postgres://app:hunter2@db:5432/lake'),
      'host=db password=hunter2 dbname=lake',
      { password: 'hunter2' },
      { name: 'AantjeError', code: 'TIMEOUT', userMessage: 'password hunter2' },
      42,
      null,
      undefined,
    ];

    expect(generic).not.toContain('marker-7f3a');
    for (const thing of secretThings) {
      expect(userMessageOf(thing)).toBe(generic);
    }
    expect(generic).not.toContain('hunter2');
  });
});

describe('messageOf and isErrnoException', () => {
  it('read the message of an Error, convert any other thrown value to text, and accept only Errors with a string code', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('plain text')).toBe('plain text');
    expect(messageOf(null)).toBe('null');
    expect(messageOf({ message: 'not an error' })).toBe('[object Object]');

    expect(isErrnoException(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    );
    expect(isErrnoException(new Error('no code'))).toBe(false);
    expect(isErrnoException(Object.assign(new Error('numeric'), { code: 7 }))).toBe(false);
    expect(isErrnoException({ code: 'EBUSY' })).toBe(false);
    expect(isErrnoException(null)).toBe(false);
    expect(isErrnoException('EBUSY')).toBe(false);
  });
});
