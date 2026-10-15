/**
 * product.json is the one source of identity. These tests fail when a file that
 * cannot import it (forge config, app-update.yml, the self-updater's expected
 * bundle id) drifts from it.
 */
import * as fs from 'fs';
import * as path from 'path';
import product from '../../../../product.json';
import { BUNDLE_ID, PRODUCT_DISPLAY_NAME, RELEASE_OWNER, RELEASE_REPO } from '../product';

const root = path.join(__dirname, '../../../..');

describe('product.json', () => {
  it('is what shared/product.ts exports', () => {
    expect(BUNDLE_ID).toBe(product.bundleId);
    expect(PRODUCT_DISPLAY_NAME).toBe(product.productName);
    expect(RELEASE_OWNER).toBe(product.releaseOwner);
    expect(RELEASE_REPO).toBe(product.releaseRepo);
  });

  it('is the Acabox PI identity, distinct from the original Acabox', () => {
    expect(product.name).toBe('acabox-pi');
    expect(product.bundleId).toBe('com.electron.acabox-pi');
    expect(product.userDataDir).toBe('acabox-pi');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name).toBe(product.name);
  });

  it('agrees with app-update.yml', () => {
    const yml = fs.readFileSync(path.join(root, 'app-update.yml'), 'utf8');
    expect(yml).toMatch(new RegExp(`^owner: ${product.releaseOwner}$`, 'm'));
    expect(yml).toMatch(new RegExp(`^repo: ${product.releaseRepo}$`, 'm'));
  });

  it('agrees with forge.config.js', () => {
    // Read as text: requiring it probes ports and resolves the esbuild binary.
    const forge = fs.readFileSync(path.join(root, 'forge.config.js'), 'utf8');
    expect(forge).toContain("require('./product.json')");
    expect(forge).toContain('name: product.productName');
    expect(forge).toContain('appBundleId: product.bundleId');
    expect(forge).not.toMatch(/com\.electron\.acabox(?!-pi)/);
  });

  it("agrees with selfUpdater's expected bundle id", () => {
    const src = fs.readFileSync(path.join(root, 'src/cobuilding/main/selfUpdater.ts'), 'utf8');
    expect(src).toContain('const expectedId = BUNDLE_ID;');
    expect(src).not.toMatch(/com\.electron\.acabox(?!-pi)(?!\.ShipIt)/);
  });
});
