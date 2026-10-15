/**
 * Product identity, read from `product.json` at the repo root, the same file
 * forge.config.js, scripts/rename-dev-electron.js, scripts/release.mjs and
 * scripts/generate-update-manifest.js read. Change it there, never here.
 */
import product from '../../../product.json';

export const PRODUCT_NAME: string = product.name;
export const PRODUCT_DISPLAY_NAME: string = product.productName;
export const BUNDLE_ID: string = product.bundleId;
export const USER_DATA_DIR: string = product.userDataDir;
export const RELEASE_OWNER: string = product.releaseOwner;
export const RELEASE_REPO: string = product.releaseRepo;
export const ENV_PREFIX: string = product.envPrefix;
