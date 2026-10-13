/**
 * A tool's sidebar pin, kept in its manifest.json beside `archived`, so it
 * goes through the same serialized, atomic `updateManifest` cycle.
 *
 * `pinnedAt` orders the rail's "Pinned tools" section: tools appear in the
 * order they were pinned, so pinning a new one never reshuffles the others.
 */

export interface ToolPin {
  pinned: boolean;
  /** When the tool was pinned (ISO 8601); null when it is not pinned. */
  pinnedAt: string | null;
}

/** Read the pin from a parsed manifest. Anything malformed reads as unpinned. */
export function readToolPin(manifest: Record<string, unknown> | null | undefined): ToolPin {
  if (manifest?.pinned !== true) return { pinned: false, pinnedAt: null };
  const at = manifest.pinnedAt;
  return { pinned: true, pinnedAt: typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null };
}

/**
 * Set or clear the pin. Pinning a tool that is already pinned keeps its
 * original `pinnedAt`, so a repeated click does not move it to the bottom.
 */
export function withToolPin(
  manifest: Record<string, unknown>,
  pinned: boolean,
  now: Date = new Date(),
): Record<string, unknown> {
  if (!pinned) {
    delete manifest.pinned;
    delete manifest.pinnedAt;
    return manifest;
  }
  const current = readToolPin(manifest);
  manifest.pinned = true;
  manifest.pinnedAt = current.pinned && current.pinnedAt ? current.pinnedAt : now.toISOString();
  return manifest;
}
