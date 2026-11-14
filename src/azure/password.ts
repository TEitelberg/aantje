import { randomInt } from 'node:crypto';

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
// Only characters that need no quoting in a connection string or a SQL literal.
const SYMBOLS = '-_';

const PASSWORD_LENGTH = 32;

/**
 * A random password with characters of all four classes, which satisfies the complexity rule of Azure Database for
 * PostgreSQL (8 to 128 characters, three of the four classes). Look-alike characters are left out because the user
 * may have to copy it from the secret storage one day.
 */
export function generatePassword(length: number = PASSWORD_LENGTH): string {
  const characters = [UPPER, LOWER, DIGITS, SYMBOLS].map(pick);
  while (characters.length < length) {
    characters.push(pick(UPPER + LOWER + DIGITS + SYMBOLS));
  }
  for (let i = characters.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [characters[i], characters[j]] = [characters[j] as string, characters[i] as string];
  }
  return characters.join('');
}

function pick(alphabet: string): string {
  return alphabet.charAt(randomInt(alphabet.length));
}
