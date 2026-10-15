import { dialog } from 'electron';
import { PRODUCT_DISPLAY_NAME } from './cobuilding/shared/product';

import('./cobuilding/main').catch((error) => {
  console.error('[main.ts] Error importing cobuilding/main:', error);
  dialog.showErrorBox(
    `${PRODUCT_DISPLAY_NAME} - Startup Error`,
    `The application failed to start.\n\n${error instanceof Error ? error.message : String(error)}`,
  );
  throw error;
});
