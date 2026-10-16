import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { hyphenate, hyphenateDir, expectedDarwinNames } = require('../../../../scripts/release-names.js');

describe('release asset names', () => {
  it('hyphenates the spaces forge puts in productName-derived names', () => {
    expect(hyphenate('Acabox PI-darwin-arm64-0.1.0.zip')).toBe('Acabox-PI-darwin-arm64-0.1.0.zip');
    expect(hyphenate('Acabox PI-0.1.0-arm64.dmg')).toBe('Acabox-PI-0.1.0-arm64.dmg');
    expect(hyphenate('latest-mac.yml')).toBe('latest-mac.yml');
  });

  it('predicts the darwin names a build will produce', () => {
    expect(expectedDarwinNames({ productName: 'Acabox PI', version: '0.1.0', arch: 'arm64', channel: 'latest' })).toEqual({
      zip: 'Acabox-PI-darwin-arm64-0.1.0.zip',
      dmg: 'Acabox-PI-0.1.0-arm64.dmg',
      yml: 'latest-mac.yml',
    });
  });

  it('renames files in a directory and leaves clean names alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relnames-'));
    fs.writeFileSync(path.join(dir, 'Acabox PI-darwin-arm64-0.1.0.zip'), 'x');
    fs.writeFileSync(path.join(dir, 'latest-mac.yml'), 'y');
    const renamed = hyphenateDir(dir);
    expect(renamed).toEqual([['Acabox PI-darwin-arm64-0.1.0.zip', 'Acabox-PI-darwin-arm64-0.1.0.zip']]);
    expect(fs.readdirSync(dir).sort()).toEqual(['Acabox-PI-darwin-arm64-0.1.0.zip', 'latest-mac.yml']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
