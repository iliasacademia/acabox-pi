import { TEXT_EDIT_IPC } from '../../../shared/miniAppTextEdit';
import type { TextEditApplyResult, TextEditProbeResult, TextEditUndoResult } from '../../../shared/miniAppTextEdit';
import { registerTextEditIpc } from '../textEditIpc';
import type { TextEditService } from '../textEditService';

type Handler = (event: any, ...args: any[]) => unknown;

function fakeIpcMain() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
  };
}

function fakeService() {
  return {
    probe: jest.fn<Promise<TextEditProbeResult>, [unknown, unknown]>(async () => ({ editable: false, reason: 'computed', message: 'm' })),
    apply: jest.fn<Promise<TextEditApplyResult>, [unknown, unknown]>(async () => ({ ok: false, editId: 'e1', reason: 'invalid', message: 'm', undoDepth: 0 })),
    undo: jest.fn<Promise<TextEditUndoResult>, [unknown]>(async () => ({ ok: false, message: 'm', undoDepth: 0 })),
    undoDepth: jest.fn<number, [unknown]>(() => 7),
  } satisfies TextEditService;
}

describe('registerTextEditIpc', () => {
  it('registers the four channels of the shared contract, and only those', () => {
    const ipc = fakeIpcMain();
    registerTextEditIpc(ipc, fakeService());
    expect([...ipc.handlers.keys()].sort()).toEqual(Object.values(TEXT_EDIT_IPC).sort());
  });

  it('hands each call to the service without the IPC event, untouched, and returns what it answers', async () => {
    const ipc = fakeIpcMain();
    const service = fakeService();
    registerTextEditIpc(ipc, service);
    const event = { sender: {} };
    const target = { text: 't', elementSrc: null, tagName: 'p', ancestorSrcs: [] };
    const req = { ...target, editId: 'e1', newText: 'n' };

    expect(await ipc.handlers.get(TEXT_EDIT_IPC.probe)?.(event, 'demo', target)).toMatchObject({ editable: false });
    expect(service.probe).toHaveBeenCalledWith('demo', target);
    expect(await ipc.handlers.get(TEXT_EDIT_IPC.apply)?.(event, 'demo', req)).toMatchObject({ ok: false, editId: 'e1' });
    expect(service.apply).toHaveBeenCalledWith('demo', req);
    expect(await ipc.handlers.get(TEXT_EDIT_IPC.undo)?.(event, 'demo')).toMatchObject({ ok: false });
    expect(service.undo).toHaveBeenCalledWith('demo');
    expect(await ipc.handlers.get(TEXT_EDIT_IPC.undoDepth)?.(event, 'demo')).toBe(7);
    expect(service.undoDepth).toHaveBeenCalledWith('demo');
  });

  it('passes whatever the renderer sent, however wrong, straight to the service to validate', async () => {
    const ipc = fakeIpcMain();
    const service = fakeService();
    registerTextEditIpc(ipc, service);
    await ipc.handlers.get(TEXT_EDIT_IPC.apply)?.({}, { not: 'a name' }, 12);
    expect(service.apply).toHaveBeenCalledWith({ not: 'a name' }, 12);
  });
});
