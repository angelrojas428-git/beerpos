import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const sourceFiles = [
  new URL('../../frontend/index.html', import.meta.url),
  new URL('../../frontend/sw.js', import.meta.url),
  new URL('../../db/schema.sql', import.meta.url),
  new URL('../src/routes/clients.js', import.meta.url),
];

describe('production text encoding', () => {
  test.each(sourceFiles)('%s is UTF-8 without BOM or mojibake', (fileUrl) => {
    const bytes = readFileSync(fileUrl);
    const text = bytes.toString('utf8');

    expect(bytes.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(Buffer.from(text, 'utf8')).toEqual(bytes);
    expect(text).not.toMatch(/[\u00c3\u00f0\u00c2\u00e2\u0192\u0178]/);
  });
});
