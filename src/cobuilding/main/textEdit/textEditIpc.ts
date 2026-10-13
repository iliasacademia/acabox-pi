import type { IpcMain } from 'electron';
import { TEXT_EDIT_IPC } from '../../shared/miniAppTextEdit';
import type { TextEditService } from './textEditService';

/**
 * Registers the four text-edit channels (shared/miniAppTextEdit.ts). Arguments
 * arrive from the renderer as `unknown`; the service validates every one.
 * Takes only `handle`, so a test can pass a fake without electron.
 */
export function registerTextEditIpc(ipcMain: Pick<IpcMain, 'handle'>, service: TextEditService): void {
  ipcMain.handle(TEXT_EDIT_IPC.probe, (_event, dirName: unknown, target: unknown) => service.probe(dirName, target));
  ipcMain.handle(TEXT_EDIT_IPC.apply, (_event, dirName: unknown, req: unknown) => service.apply(dirName, req));
  ipcMain.handle(TEXT_EDIT_IPC.undo, (_event, dirName: unknown) => service.undo(dirName));
  ipcMain.handle(TEXT_EDIT_IPC.undoDepth, (_event, dirName: unknown) => service.undoDepth(dirName));
}
