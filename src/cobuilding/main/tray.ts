import { app, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import log from 'electron-log';
import { isUpdaterConfigured, checkForUpdates } from './updater';
import { PRODUCT_DISPLAY_NAME } from '../shared/product';

// Cyan (#00BCD4) in BGRA byte order — tints the dock mark for dev builds so a
// dev instance is distinguishable from a packaged one. Darker pixels (the blue
// tile) shift toward cyan; the white glyph is preserved (see the brightness lerp).
const DEV_LOGO_TINT = { b: 212, g: 188, r: 0 };

let tray: Tray | null = null;
let currentTrayMenu: Electron.Menu | null = null;
let showWindowCallback: (() => void) | null = null;

export function setShowWindowCallback(callback: () => void) {
  showWindowCallback = callback;
}

export function rebuildTrayMenu(statusLabel?: string) {
  if (!tray) return;

  const menuItems: Electron.MenuItemConstructorOptions[] = [];

  if (showWindowCallback) {
    menuItems.push({
      label: 'Show Window',
      click: () => showWindowCallback?.(),
    });
    menuItems.push({ type: 'separator' });
  }

  menuItems.push({
    label: statusLabel || 'Check for Updates...',
    enabled: !statusLabel && isUpdaterConfigured(),
    click: () => {
      rebuildTrayMenu('Checking...');
      checkForUpdates(true);
    },
  });
  if (statusLabel && !statusLabel.startsWith('Update available')) {
    setTimeout(() => rebuildTrayMenu(), 5000);
  }

  menuItems.push(
    { type: 'separator' },
    {
      label: `Version: ${app.getVersion()}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  );

  currentTrayMenu = Menu.buildFromTemplate(menuItems);
}

// Menu-bar extra: the glyph-only B-box mark as a macOS template image. The PNG
// is opaque black on transparent (18pt canvas, 16pt glyph); `setTemplateImage`
// tells AppKit to key off the alpha channel and recolor it per the menu-bar
// appearance (light/dark/tint). The @2x companion is picked up automatically
// from the sibling trayTemplate@2x.png. Regenerate via scripts/gen-icons.mjs.
function createTrayIcon(): Electron.NativeImage | null {
  const iconPath = path.join(__dirname, 'assets/icons/trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return null;
  icon.setTemplateImage(true);
  return icon;
}

// Returns the icon to use for the macOS dock.
// Production: the B-box brand mark at native resolution.
// Dev: same image, dark pixels shifted toward cyan (white glyph preserved).
// Both paths use the full image bounds so the icon appears the same size as other dock icons.
export function createDockIcon(): Electron.NativeImage | null {
  const iconPath = path.join(__dirname, 'assets/icons/dock-icon.png');
  const baseIcon = nativeImage.createFromPath(iconPath);
  if (baseIcon.isEmpty()) return null;

  if (app.isPackaged) return baseIcon;

  const { width, height } = baseIcon.getSize();
  const bitmap = baseIcon.toBitmap();
  const buf = Buffer.alloc(width * height * 4);

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const srcA = bitmap[idx + 3];
    if (srcA === 0) continue;

    // Both toBitmap() and createFromBuffer use BGRA on macOS
    const fgB = bitmap[idx];
    const fgG = bitmap[idx + 1];
    const fgR = bitmap[idx + 2];
    // t=0 at black, t=1 at white — lerp from tint toward original
    const t = (fgB + fgG + fgR) / (3 * 255);
    buf[idx] = Math.round(DEV_LOGO_TINT.b + (fgB - DEV_LOGO_TINT.b) * t);
    buf[idx + 1] = Math.round(DEV_LOGO_TINT.g + (fgG - DEV_LOGO_TINT.g) * t);
    buf[idx + 2] = Math.round(DEV_LOGO_TINT.r + (fgR - DEV_LOGO_TINT.r) * t);
    buf[idx + 3] = srcA;
  }

  return nativeImage.createFromBuffer(buf, { width, height });
}

export function createTray() {
  const icon = createTrayIcon();
  if (!icon) {
    log.warn('[TRAY] Failed to load tray icon, skipping tray creation.');
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip(PRODUCT_DISPLAY_NAME);
  log.info('[TRAY] Tray created.');

  // Use click handlers instead of setContextMenu to work around Electron tray menu crash on macOS
  tray.on('click', () => {
    if (tray && currentTrayMenu) tray.popUpContextMenu(currentTrayMenu);
  });
  tray.on('right-click', () => {
    if (tray && currentTrayMenu) tray.popUpContextMenu(currentTrayMenu);
  });

  rebuildTrayMenu();
}
