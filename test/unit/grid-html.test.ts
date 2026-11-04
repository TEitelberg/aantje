import { describe, expect, it } from 'vitest';
import { gridHtml } from '../../src/grid/html';
import { GRID_CSS } from '../../src/grid/style';

const options = {
  nonce: 'abc123+/=',
  scriptUri: 'https://file+.vscode-resource.vscode-cdn.net/ext/dist/grid-client.js',
  title: 'sales.orders',
};
const POLICY = `default-src 'none'; style-src 'nonce-abc123+/='; script-src 'nonce-abc123+/='; base-uri 'none'; form-action 'none'`;

describe('gridHtml', () => {
  it('builds the page: strict CSP, one nonce-protected stylesheet and script, an empty body', () => {
    expect(gridHtml(options)).toBe(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${POLICY}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>sales.orders</title>
<style nonce="abc123+/=">${GRID_CSS}</style>
</head>
<body>
<script nonce="abc123+/=" src="https://file+.vscode-resource.vscode-cdn.net/ext/dist/grid-client.js"></script>
</body>
</html>
`);
  });

  it('takes the stylesheet of another page with the same policy, and the nonce it is given', () => {
    const html = gridHtml({ ...options, css: '.card { color: red; }' });
    expect(html).toContain('<style nonce="abc123+/=">.card { color: red; }</style>');
    expect(html).not.toContain(GRID_CSS);
    expect(html).toContain(`content="${POLICY}"`);
    expect(html).not.toMatch(/unsafe-|\sstyle="|\son[a-z]+=/i);

    const other = gridHtml({ ...options, nonce: 'other' });
    expect(other).toContain('<script nonce="other"');
    expect(other).not.toContain('abc123');
  });

  it('escapes hostile text and cannot be broken out of an attribute', () => {
    const cases: { options: typeof options; contains: string[]; notContains: string[] }[] = [
      {
        options: { ...options, title: `</title><script>alert("x")</script> & 'q'` },
        contains: [
          '<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</title>',
        ],
        notContains: ['<script>alert'],
      },
      {
        options: { ...options, title: `</title><img src=x onerror=alert(1)>.sql · results` },
        contains: ['<title>&lt;/title&gt;&lt;img src=x onerror=alert(1)&gt;.sql · results</title>'],
        notContains: ['<img'],
      },
      {
        options: { nonce: 'x"><script>1</script>', scriptUri: 'x" onload="alert(1)', title: 't' },
        contains: ['src="x&quot; onload=&quot;alert(1)"'],
        notContains: ['<script>1', '" onload='],
      },
    ];
    for (const { options: hostile, contains, notContains } of cases) {
      const html = gridHtml(hostile);
      for (const text of contains) expect(html).toContain(text);
      for (const text of notContains) expect(html).not.toContain(text);
      expect(html.match(/<script/g)).toHaveLength(1);
    }
  });
});
