import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWakeLock, type WakeLockController, type WakeLockSentinelLike } from './wakeLock';

/** A sentinel that the "browser" can release, like the real one does when the tab is hidden. */
class FakeSentinel extends EventTarget implements WakeLockSentinelLike {
  released = false;
  readonly release = vi.fn(async () => {
    this.browserRelease();
  });

  browserRelease(): void {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function setup(visibility: DocumentVisibilityState = 'visible') {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(async (_type: 'screen') => {
    const sentinel = new FakeSentinel();
    sentinels.push(sentinel);
    return sentinel;
  });
  const document = new FakeDocument();
  document.visibilityState = visibility;
  const navigator = { wakeLock: { request } };
  return { request, document, navigator, sentinels };
}

/** Lets pending request/release promises settle. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let controller: WakeLockController | undefined;

afterEach(() => {
  controller?.dispose();
  controller = undefined;
  vi.restoreAllMocks();
});

describe('createWakeLock', () => {
  it('requests the lock on start when the tab is visible', async () => {
    const { request, document, navigator } = setup();
    controller = createWakeLock({ navigator, document });
    controller.setActive(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');
    expect(controller.isHeld()).toBe(true);
  });

  it('requests it again when the tab becomes visible after the browser released it', async () => {
    const { request, document, navigator, sentinels } = setup();
    controller = createWakeLock({ navigator, document });
    controller.setActive(true);
    await flush();

    // Hidden: the browser releases the lock, and nothing is requested while hidden.
    document.setVisibility('hidden');
    sentinels[0]!.browserRelease();
    await flush();
    expect(controller.isHeld()).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);

    document.setVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.isHeld()).toBe(true);
  });

  it('does not request a second lock on visibilitychange while one is still held', async () => {
    const { request, document, navigator } = setup();
    controller = createWakeLock({ navigator, document });
    controller.setActive(true);
    await flush();
    document.setVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('releases the lock on pause and requests it again on resume', async () => {
    const { request, document, navigator, sentinels } = setup();
    controller = createWakeLock({ navigator, document });
    controller.setActive(true);
    await flush();

    controller.setActive(false);
    await flush();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
    expect(controller.isHeld()).toBe(false);

    controller.setActive(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.isHeld()).toBe(true);
  });

  it('does not request the lock while paused, even when the tab becomes visible', async () => {
    const { request, document, navigator } = setup('hidden');
    controller = createWakeLock({ navigator, document });
    controller.setActive(false);
    document.setVisibility('visible');
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not request the lock while hidden, and requests it once visible', async () => {
    const { request, document, navigator } = setup('hidden');
    controller = createWakeLock({ navigator, document });
    controller.setActive(true);
    await flush();
    expect(request).not.toHaveBeenCalled();

    document.setVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('releases a lock granted after travel was paused', async () => {
    const { request, document, navigator, sentinels } = setup();
    controller = createWakeLock({ navigator, document });
    controller.setActive(true);
    controller.setActive(false); // paused before the request resolved
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);
    expect(controller.isHeld()).toBe(false);
  });

  it('releases the lock and stops listening on dispose', async () => {
    const { request, document, navigator, sentinels } = setup();
    controller = createWakeLock({ navigator, document });
    controller.setActive(true);
    await flush();
    controller.dispose();
    await flush();
    expect(sentinels[0]!.release).toHaveBeenCalledTimes(1);

    document.setVisibility('hidden');
    document.setVisibility('visible');
    controller.setActive(true);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does nothing and logs nothing where the Wake Lock API is unsupported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const document = new FakeDocument();
    expect(() => {
      controller = createWakeLock({ navigator: { wakeLock: undefined }, document });
      controller.setActive(true);
      document.setVisibility('hidden');
      document.setVisibility('visible');
      controller.setActive(false);
      controller.setActive(true);
    }).not.toThrow();
    await flush();
    expect(controller!.isHeld()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs a console warning and does not throw when the request is rejected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('NotAllowedError');
    const request = vi.fn((_type: 'screen'): Promise<WakeLockSentinelLike> => Promise.reject(failure));
    const document = new FakeDocument();
    controller = createWakeLock({ navigator: { wakeLock: { request } }, document });
    expect(() => controller!.setActive(true)).not.toThrow();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toContain(failure);
    expect(error).not.toHaveBeenCalled();
    expect(controller.isHeld()).toBe(false);

    // A later trigger tries again.
    document.setVisibility('hidden');
    document.setVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('logs a console warning and does not throw when the request throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const request = vi.fn((_type: 'screen'): Promise<WakeLockSentinelLike> => {
      throw new Error('boom');
    });
    controller = createWakeLock({ navigator: { wakeLock: { request } }, document: new FakeDocument() });
    expect(() => controller!.setActive(true)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
