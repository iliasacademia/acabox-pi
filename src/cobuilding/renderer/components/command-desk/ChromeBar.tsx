import React, { useState, useEffect } from 'react';
import { PRODUCT_DISPLAY_NAME } from '../../../shared/product';
import { AcaboxMark } from './AcaboxMark';
import { chromeHealth } from './chromeHealth';

const HEALTH_DOT = {
  starting: 'var(--cd-busy)',
  ready: 'var(--cd-success)',
  offline: 'var(--cd-error)',
} as const;

/**
 * The 40px window-chrome bar. With `titleBarStyle: 'hiddenInset'` on the main
 * window this IS the title bar: the whole strip is a drag region and the
 * native traffic lights sit in the left inset (cleared by CSS padding).
 *
 * Health = agent-server liveness via containerAPI.status(), polled.
 */
export function ChromeBar({ right }: { right?: React.ReactNode }) {
  const [health, setHealth] = useState<'starting' | 'ready' | 'offline'>('starting');

  useEffect(() => {
    let alive = true;
    const poll = () => {
      window.containerAPI
        .status()
        .then((s) => { if (alive) setHealth(chromeHealth(s)); })
        .catch(() => { if (alive) setHealth('starting'); });
    };
    poll();
    const timer = setInterval(poll, 10_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const version = process.env.APP_VERSION || '0.0.0';

  return (
    <div className="cdChrome">
      <div className="cdChrome__title">
        <AcaboxMark size={16} className="cdChrome__mark" />
        {/* Not "LOCAL VM": the fork removed the Podman container, and everything
            now runs as host child processes. The old string claimed a VM that has
            not existed since the slim-down — the same class of stale copy the
            de-Podman pass cleaned out of the agent-facing docs. */}
        <span>{PRODUCT_DISPLAY_NAME.toUpperCase()} · V{version}</span>
      </div>
      <div className="cdChrome__right">
        {right}
        <span
          className="cdChrome__health"
          title={health === 'offline' ? 'The assistant stopped. Quit and reopen ' + PRODUCT_DISPLAY_NAME + '.' : undefined}
        >
          <span
            className="cdDot"
            style={{ background: HEALTH_DOT[health] }}
          />
          {health.toUpperCase()}
        </span>
      </div>
    </div>
  );
}
