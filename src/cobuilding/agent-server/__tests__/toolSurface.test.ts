/** @jest-environment node */
/**
 * The model-visible surface of the 12 host-relay tools, recorded from the
 * Claude Agent SDK relay servers by `scripts/record-tool-surface.mjs`
 * (plan P0-08). P1-09 re-implements these as PI customTools under the same
 * `mcp__<server>__<tool>` names and must reproduce this surface.
 */
import fixture from './toolSurface.fixture.json';

describe('tool surface fixture', () => {
  it('lists exactly the 12 relay tools, uniquely named', () => {
    expect(fixture.count).toBe(12);
    expect(fixture.tools).toHaveLength(12);
    expect(new Set(fixture.tools.map((t) => t.name)).size).toBe(12);
    for (const t of fixture.tools) {
      expect(t.name).toBe(`mcp__${t.server}__${t.tool}`);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  // Turned on by P1-09: build the PI customTools from the same definitions and
  // compare name, description and input schema against the fixture.
  it.skip('is reproduced by the PI customTools', () => {
    throw new Error('enabled by P1-09');
  });
});
