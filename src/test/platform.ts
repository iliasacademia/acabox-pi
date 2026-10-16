/**
 * Platform tags for jest. Suites or cases that need macOS (bsdtar, BSD libc
 * semantics, the real helpers) use `describeMac` / `itMac`: they run unchanged
 * on darwin and are skipped elsewhere, with the reason in the title so
 * `npm run test:linux` can list them. Never delete or weaken a test to make it
 * pass on Linux; tag it here instead.
 */
export const isMac = process.platform === 'darwin';

type Fn = jest.ProvidesCallback;
type TestFn = (name: string, fn: Fn, timeout?: number) => void;

function tag(reason: string, name: string): string {
  return `[mac-only: ${reason}] ${name}`;
}

export function describeMac(reason: string, name: string, fn: () => void): void {
  (isMac ? describe : describe.skip)(isMac ? name : tag(reason, name), fn);
}

export function itMac(reason: string, name: string, fn: Fn, timeout?: number): void {
  (isMac ? it : it.skip)(isMac ? name : tag(reason, name), fn, timeout);
}

itMac.each =
  <T>(cases: readonly T[]) =>
  (reason: string, name: string, fn: (arg: T) => void | Promise<unknown>, timeout?: number): void => {
    (isMac ? it.each : it.skip.each)(cases)(isMac ? name : tag(reason, name), fn as never, timeout);
  };

/** Cases that rely on file permissions being enforced; root (the cloud VM) bypasses them. */
export const itNotRoot: TestFn = (name, fn, timeout) =>
  (process.getuid?.() === 0 ? it.skip : it)(
    process.getuid?.() === 0 ? `[skipped as root: file permissions are not enforced] ${name}` : name,
    fn,
    timeout,
  );
