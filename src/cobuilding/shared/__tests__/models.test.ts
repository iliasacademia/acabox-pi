import {
  BACKGROUND_MODEL,
  BACKGROUND_REQUEST,
  CURATED_MODELS,
  DEFAULT_MODEL,
  KNOWN_MODEL_IDS,
  MAX_AUTO_ADDED_MODELS,
  SUPERSEDED_MODEL_IDS,
  UNSUPPORTED_MODEL_IDS,
  allowedModelIds,
  mergeModels,
  messageText,
  type DiscoveredModel,
} from '../models';

/**
 * The merge rule is the whole feature: it decides what a user sees in the
 * picker when Anthropic ships something. Both halves of the rule ("we have
 * never heard of this id" AND "it is newer than everything we have heard of")
 * have a failure case the other does not cover, so each gets its own test —
 * dropping either half leaves one of these red.
 */

/** A plausible roster: the models this build knows, with real-ish dates. */
const KNOWN_ROSTER: DiscoveredModel[] = [
  { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', created_at: '2026-08-31T00:00:00Z' },
  { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-04-01T00:00:00Z' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-03-01T00:00:00Z' },
  { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
];

const ids = (list: { id: string }[]) => list.map((m) => m.id);

describe('the curated table', () => {
  test('offers Fable 5.1, having superseded Fable 5', () => {
    // 5.1 was held out until the Agent SDK could run it: on SDK 0.2.121 a real
    // turn returned "Claude Code 2.1.121 does not support this model; version
    // 2.1.251 or newer is required". SDK 0.3.273 cleared it, re-verified with
    // a real turn, so it is offered and Fable 5 steps down to superseded.
    expect(ids([...CURATED_MODELS])).toContain('claude-fable-5-1');
    expect(ids([...CURATED_MODELS])).not.toContain('claude-fable-5');
    expect(SUPERSEDED_MODEL_IDS).toContain('claude-fable-5');
  });

  test('anything held out for CLI support stays KNOWN, so discovery cannot re-add it', () => {
    // Empty today, and the assertion still earns its place: the next model
    // this build's CLI is too old for goes in UNSUPPORTED_MODEL_IDS, and if
    // it is not also reachable from KNOWN_MODEL_IDS the merge reads it as a
    // fresh release and puts it straight back in the picker — where it 400s.
    for (const id of UNSUPPORTED_MODEL_IDS) expect(KNOWN_MODEL_IDS).toContain(id);

    // Proven with a stand-in rather than skipped while the list is empty.
    const merged = mergeModels([
      ...KNOWN_ROSTER,
      { id: 'claude-fable-5', display_name: 'Claude Fable 5', created_at: '2027-01-01T00:00:00Z' },
    ]);
    expect(ids(merged)).not.toContain('claude-fable-5');
  });

  test('the pinned default is a model we actually offer', () => {
    // A default absent from the roster would make every new chat fall through
    // to the picker's own fallback, which is a silent, confusing downgrade.
    expect(ids([...CURATED_MODELS])).toContain(DEFAULT_MODEL);
  });

  test('no id appears in both the curated and superseded lists', () => {
    const curated = new Set(ids([...CURATED_MODELS]));
    for (const id of SUPERSEDED_MODEL_IDS) expect(curated.has(id)).toBe(false);
    expect(new Set(KNOWN_MODEL_IDS).size).toBe(KNOWN_MODEL_IDS.length);
  });
});

describe('mergeModels', () => {
  test('a roster holding only models we know changes nothing', () => {
    expect(mergeModels(KNOWN_ROSTER)).toEqual([...CURATED_MODELS]);
  });

  test('a genuinely new model is added, at the top, with the API label', () => {
    const merged = mergeModels([
      ...KNOWN_ROSTER,
      { id: 'claude-opus-6', display_name: 'Claude Opus 6', created_at: '2026-11-01T00:00:00Z' },
    ]);
    expect(merged[0]).toMatchObject({
      id: 'claude-opus-6',
      label: 'Claude Opus 6',   // Anthropic's name, not the raw id
      discovered: true,
    });
    // ...and it is an addition, never a replacement.
    expect(ids(merged).slice(1)).toEqual(ids([...CURATED_MODELS]));
  });

  test('an OLD model we never curated is not mistaken for a new one', () => {
    // The case that "unknown id" alone gets wrong. This model is unknown to
    // us and real, but predates everything we know — it must stay hidden.
    const merged = mergeModels([
      ...KNOWN_ROSTER,
      { id: 'claude-3-5-sonnet-20240620', display_name: 'Claude Sonnet 3.5', created_at: '2024-06-20T00:00:00Z' },
    ]);
    expect(merged).toEqual([...CURATED_MODELS]);
  });

  test('a retired model is not resurrected by being newer than the rest', () => {
    // The case that "newer than what we know" alone gets wrong. Opus 4.7 is
    // deliberately not offered; a roster that dates it after everything else
    // must not put it back in the menu.
    const merged = mergeModels([
      { id: 'claude-opus-5', created_at: '2026-04-01T00:00:00Z' },
      { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2027-01-01T00:00:00Z' },
    ]);
    expect(ids(merged)).not.toContain('claude-opus-4-7');
  });

  test('adds nothing when it cannot recognise a single model', () => {
    // No known id means no trustworthy cutoff. Conservative: show the
    // built-in list rather than reorder the UI from a roster we cannot
    // locate ourselves in.
    const merged = mergeModels([
      { id: 'something-else-entirely', created_at: '2099-01-01T00:00:00Z' },
    ]);
    expect(merged).toEqual([...CURATED_MODELS]);
  });

  test('an empty or dateless roster falls back to the curated list', () => {
    expect(mergeModels([])).toEqual([...CURATED_MODELS]);
    // A known model with no date gives no cutoff, so nothing is added.
    expect(mergeModels([{ id: 'claude-opus-5' }, { id: 'brand-new' }])).toEqual([...CURATED_MODELS]);
    // A newcomer with no date cannot be placed, so it is skipped.
    expect(mergeModels([...KNOWN_ROSTER, { id: 'brand-new' }])).toEqual([...CURATED_MODELS]);
  });

  test('newcomers are newest-first and capped', () => {
    const many: DiscoveredModel[] = Array.from({ length: MAX_AUTO_ADDED_MODELS + 4 }, (_, i) => ({
      id: `future-model-${i}`,
      // Later index == later date, so the cap must keep the LAST ones.
      created_at: `2027-0${(i % 9) + 1}-01T00:00:00Z`.replace('2027-0', `202${7 + Math.floor(i / 9)}-0`),
      display_name: `Future ${i}`,
    }));
    const merged = mergeModels([...KNOWN_ROSTER, ...many]);
    const added = merged.filter((m) => m.discovered);
    expect(added.length).toBe(MAX_AUTO_ADDED_MODELS);
    // Descending by date — the newest release leads the menu.
    const dates = added.map((m) => many.find((x) => x.id === m.id)!.created_at!);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  test('a duplicated id across pages renders once', () => {
    const dupe = { id: 'claude-opus-6', display_name: 'Claude Opus 6', created_at: '2026-11-01T00:00:00Z' };
    const merged = mergeModels([...KNOWN_ROSTER, dupe, { ...dupe }]);
    expect(ids(merged).filter((id) => id === 'claude-opus-6')).toHaveLength(1);
  });

  test('a newcomer with no display_name falls back to its id, never blank', () => {
    const merged = mergeModels([
      ...KNOWN_ROSTER,
      { id: 'claude-opus-6', display_name: '   ', created_at: '2026-11-01T00:00:00Z' },
    ]);
    expect(merged[0].label).toBe('claude-opus-6');
  });
});

describe('allowedModelIds', () => {
  test('is the union of what we know and what the account can reach', () => {
    const allowed = allowedModelIds([
      { id: 'claude-opus-6' },
      { id: 'claude-opus-5' },
    ]);
    // Everything built in stays allowed even if discovery never runs...
    for (const id of KNOWN_MODEL_IDS) expect(allowed.has(id)).toBe(true);
    // ...and a model the API reports is allowed without a code change, which
    // is what stops "pickable in chat, refused inside a mini-app".
    expect(allowed.has('claude-opus-6')).toBe(true);
  });

  test('still allows the built-in roster when discovery returns nothing', () => {
    const allowed = allowedModelIds([]);
    expect(allowed.has(DEFAULT_MODEL)).toBe(true);
    expect(allowed.has('claude-fable-5-1')).toBe(true);
  });

  test('does not allow an id nobody reported', () => {
    expect(allowedModelIds([]).has('gpt-4')).toBe(false);
  });
});

describe('DEFAULT_MODEL', () => {
  test('is Opus 5.5 (owner decision 2026-10-01) and is allowed in mini-apps', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
    expect(allowedModelIds([]).has(DEFAULT_MODEL)).toBe(true);
  });
});

describe('the 5.5 generation (2026-10-12)', () => {
  test('offers Sonnet 5.5 and Haiku 5.5, with their predecessors superseded, not unknown', () => {
    // SDK 0.3.280 ran both but priced them as "unknown" and assumed a 200K
    // window; 0.3.296 knows them. The predecessors must stay KNOWN, or the
    // next discovery would re-add them to the picker as new releases.
    const curated = ids([...CURATED_MODELS]);
    expect(curated).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'claude-haiku-5-5']));
    expect(curated).not.toContain('claude-sonnet-5');
    expect(curated).not.toContain('claude-haiku-4-5');
    expect(SUPERSEDED_MODEL_IDS).toEqual(expect.arrayContaining(['claude-sonnet-5', 'claude-haiku-4-5']));
    expect(mergeModels(KNOWN_ROSTER).map((m) => m.id)).not.toContain('claude-sonnet-5');
  });
});

describe('background calls', () => {
  test('run on Haiku 5.5 with thinking off, which is only legal at effort low..high', () => {
    expect(BACKGROUND_MODEL).toBe('claude-haiku-5-5');
    expect(BACKGROUND_REQUEST.model).toBe(BACKGROUND_MODEL);
    expect(BACKGROUND_REQUEST.thinking).toEqual({ type: 'disabled' });
    expect(['low', 'medium', 'high']).toContain(BACKGROUND_REQUEST.output_config.effort);
  });

  test('messageText reads past leading thinking blocks', () => {
    // The shape a thinking model returns: content[0] is thinking, so the old
    // position-0 read gave '' — a title that silently never arrived.
    const reply = {
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'Liver Atlas Review' },
      ],
    };
    expect(messageText(reply)).toBe('Liver Atlas Review');
    expect(messageText({ content: [{ type: 'thinking' }] })).toBe('');
    expect(messageText({ content: [] })).toBe('');
  });
});
