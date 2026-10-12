import React, { useState, useEffect } from 'react';
import { useAssistantRuntime, useAuiState } from '@assistant-ui/react';
import { DropdownMenu } from 'radix-ui';
import { MSymbol } from './command-desk/MSymbol';
import { CURATED_MODELS, DEFAULT_MODEL as SHARED_DEFAULT_MODEL, supersededModelLabel, type PickerModel } from '../../shared/models';

/**
 * The roster this module renders.
 *
 * Starts as the built-in curated list and is REPLACED by the merged one
 * (built-in + anything `GET /v1/models` reports that we have never heard of)
 * as soon as main answers — see `shared/models.ts`. A module-level mutable
 * copy rather than component state because the synchronous label helpers
 * below are called from outside React (`useSessionMeta`, the chat adapter),
 * and they must name a newly discovered model correctly too.
 */
let MODELS: PickerModel[] = [...CURATED_MODELS];

/** Notifies mounted pickers that the roster changed under them. */
const ROSTER_EVENT = 'cd:models-changed';

/**
 * Ask main for the merged roster. Safe to call repeatedly — main caches and
 * single-flights the network side. Failure is a no-op: `MODELS` keeps the
 * built-in list, which is why no caller has to handle a missing roster.
 */
export async function refreshModelRoster(): Promise<void> {
  try {
    const res = await window.modelsAPI?.list();
    if (!res || !Array.isArray(res.models) || res.models.length === 0) return;
    MODELS = res.models;
    window.dispatchEvent(new CustomEvent(ROSTER_EVENT));
  } catch {
    /* Built-in list stands. */
  }
}

// Thinking-level dial. Values are the Claude Agent SDK `effort` levels
// (query() option); labels mirror the Claude Desktop app ("Extra" == 'xhigh').
// Effort works alongside adaptive thinking to guide reasoning depth.
export type EffortId = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: { id: EffortId; label: string; note?: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra' },
  // 'max' is only honored on the most capable models (e.g. the Opus tier);
  // lighter models fall back to their top supported level.
  { id: 'max', label: 'Max', note: 'Best on the most capable models' },
];

const MODEL_KEY = 'selectedModel';
const EFFORT_KEY = 'selectedEffort';
const DEFAULT_MODEL = SHARED_DEFAULT_MODEL;
const DEFAULT_EFFORT: EffortId = 'high';

function readModel(): string {
  // Stored value may reference a model removed from the list; fall back.
  //
  // Checked against the CURRENT roster, which is why discovery only ever adds:
  // were a discovered model to drop out of a later response, a user pinned to
  // it would silently fall back to the default rather than keep sending an id
  // the account can no longer use.
  const stored = localStorage.getItem(MODEL_KEY);
  return stored && MODELS.some((m) => m.id === stored) ? stored : DEFAULT_MODEL;
}

function readEffort(): EffortId {
  const stored = localStorage.getItem(EFFORT_KEY) as EffortId | null;
  return stored && EFFORTS.some((e) => e.id === stored) ? stored : DEFAULT_EFFORT;
}

/**
 * Display label for a model id. Ids come from two places: this picker, and the
 * Agent SDK's init event (what it actually resolved), which can name a model
 * that isn't in the list above — a snapshot id, or one dropped from the picker.
 * Those fall back to the raw id so the header never claims the wrong model.
 */
export function formatModelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? supersededModelLabel(id) ?? id;
}

/** Display label for an effort id; unknown values pass through unchanged. */
export function formatEffortLabel(id: string): string {
  return EFFORTS.find((e) => e.id === id)?.label ?? id;
}

/** Display label of the currently selected model (for mono header metas). */
export function getSelectedModelLabel(): string {
  return formatModelLabel(readModel());
}

/** Selected model id — read at send time by the chat adapter. */
export function getSelectedModel(): string {
  return readModel();
}

/** Selected effort id — read at send time by the chat adapter. */
export function getSelectedEffort(): EffortId {
  return readEffort();
}

/** Display label of the currently selected effort level. */
export function getSelectedEffortLabel(): string {
  const id = readEffort();
  return EFFORTS.find((e) => e.id === id)?.label ?? 'High';
}

/**
 * The model/effort the CURRENT chat is pinned to, or null while it is still
 * free to choose.
 *
 * A conversation is pinned on its first turn — main records the model the SDK
 * actually resolved and from then on the pin beats whatever this picker says
 * (`chat:send` in `main/index.ts`). A picker that still looked live in a
 * pinned chat would therefore be offering a choice that has no effect, which
 * is what made "I can't change the model" look like a missing control rather
 * than a deliberate pin.
 *
 * Fetched here rather than through `useSessionMeta`, which imports this
 * module's label formatters — importing it back would close a cycle.
 */
function usePinnedSelection(): { model: string; effort: string | null } | null {
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  // The pin is written mid-turn, so a finished turn is the moment to re-read.
  const isRunning = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;
  const [pin, setPin] = useState<{ model: string; effort: string | null } | null>(null);

  useEffect(() => {
    if (!remoteId) { setPin(null); return; }
    let cancelled = false;
    window.sessionsAPI.get(remoteId)
      .then((session) => {
        if (cancelled) return;
        setPin(session?.model ? { model: session.model, effort: session.effort ?? null } : null);
      })
      .catch(() => { if (!cancelled) setPin(null); });
    return () => { cancelled = true; };
  }, [remoteId, isRunning]);

  return pin;
}

export const ModelSelector: React.FC = () => {
  const [model, setModel] = useState(readModel);
  const [effort, setEffort] = useState<EffortId>(readEffort);
  // Bumped when the roster is replaced, purely to force a re-render — MODELS
  // is module state, so React cannot see it change on its own.
  const [, setRosterTick] = useState(0);
  const runtime = useAssistantRuntime();

  useEffect(() => {
    const onRoster = () => setRosterTick((n) => n + 1);
    window.addEventListener(ROSTER_EVENT, onRoster);
    void refreshModelRoster();
    return () => window.removeEventListener(ROSTER_EVENT, onRoster);
  }, []);

  // Model rides to the agent via the assistant-ui model context (read as
  // context.config.modelName in chatAdapter). Effort is read from localStorage
  // at send time via getSelectedEffort() instead.
  useEffect(() => {
    return runtime.registerModelContextProvider({
      getModelContext: () => ({
        config: { modelName: model },
      }),
    });
  }, [runtime, model]);

  const pinned = usePinnedSelection();

  const changeModel = (value: string) => {
    setModel(value);
    localStorage.setItem(MODEL_KEY, value);
    window.dispatchEvent(new CustomEvent('cd:model-changed'));
  };

  const changeEffort = (value: string) => {
    const next = value as EffortId;
    setEffort(next);
    localStorage.setItem(EFFORT_KEY, next);
    window.dispatchEvent(new CustomEvent('cd:effort-changed'));
  };

  // Fall back by ID, never by array index: the old `MODELS[1]` meant "Opus 5"
  // only because of where it sat in a fixed array, and discovery prepends.
  const currentModel = MODELS.find((m) => m.id === model)
    ?? MODELS.find((m) => m.id === DEFAULT_MODEL)
    ?? MODELS[0];
  const currentEffort = EFFORTS.find((e) => e.id === effort) ?? EFFORTS[2];

  // Pinned chat: show what this conversation actually runs on, and say why it
  // cannot be changed. Deliberately not hidden — the model a chat is using is
  // exactly what someone opening the picker came to find out.
  if (pinned) {
    const pinnedModel = formatModelLabel(pinned.model);
    const pinnedEffort = pinned.effort ? formatEffortLabel(pinned.effort) : null;
    return (
      <button
        type="button"
        className="modelSelectorTrigger modelSelectorTrigger--pinned"
        disabled
        aria-label={`Model pinned to this chat: ${pinnedModel}`}
        title={
          `This chat runs on ${pinnedModel}${pinnedEffort ? ` \u00b7 ${pinnedEffort}` : ''}, `
          + 'fixed when it started. Start a new chat to use a different model.'
        }
      >
        <span className="modelSelectorTriggerModel">{pinnedModel}</span>
        {pinnedEffort && <span className="modelSelectorTriggerEffort">{pinnedEffort}</span>}
        <MSymbol name="lock" size={14} />
      </button>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="modelSelectorTrigger" aria-label="Model and effort">
          <span className="modelSelectorTriggerModel">{currentModel.label}</span>
          <span className="modelSelectorTriggerEffort">{currentEffort.label}</span>
          <MSymbol name="expand_more" size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="modelMenuContent" align="end" side="top" sideOffset={6}>
          {/* Currently selected model, shown prominently (matches desktop). */}
          <div className="modelMenuCurrent">
            <span className="modelMenuCurrentText">
              <span className="modelMenuCurrentLabel">{currentModel.label}</span>
              <span className="modelMenuItemDesc">{currentModel.description}</span>
            </span>
            <MSymbol name="check" size={18} className="modelMenuCheck" />
          </div>

          <DropdownMenu.Separator className="modelMenuSep" />

          {/* Effort submenu */}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="modelMenuItem modelMenuSubTrigger">
              <span className="modelMenuItemLabel">Effort</span>
              <span className="modelMenuItemRight">
                <span className="modelMenuValue">{currentEffort.label}</span>
                <MSymbol name="chevron_right" size={18} />
              </span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="modelMenuContent modelMenuWide" sideOffset={4} alignOffset={-4}>
                <div className="modelMenuBlurb">
                  Higher effort means more thorough responses, but takes longer and uses your limits faster.
                </div>
                <DropdownMenu.RadioGroup value={effort} onValueChange={changeEffort}>
                  {EFFORTS.map((e) => (
                    <DropdownMenu.RadioItem key={e.id} value={e.id} className="modelMenuItem modelMenuRadio">
                      <span className="modelMenuItemLabel">
                        {e.label}
                        {e.id === DEFAULT_EFFORT && <span className="modelMenuBadge">Default</span>}
                        {e.note && (
                          <span className="modelMenuInfo" title={e.note}>
                            <MSymbol name="info" size={14} />
                          </span>
                        )}
                      </span>
                      <DropdownMenu.ItemIndicator className="modelMenuIndicator">
                        <MSymbol name="check" size={18} />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          {/* More models submenu */}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="modelMenuItem modelMenuSubTrigger">
              <span className="modelMenuItemLabel">More models</span>
              <span className="modelMenuItemRight">
                <MSymbol name="chevron_right" size={18} />
              </span>
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="modelMenuContent modelMenuWide" sideOffset={4} alignOffset={-4}>
                <DropdownMenu.RadioGroup value={model} onValueChange={changeModel}>
                  {MODELS.map((m) => (
                    <DropdownMenu.RadioItem
                      key={m.id}
                      value={m.id}
                      className="modelMenuItem modelMenuRadio modelMenuModelItem"
                    >
                      <span className="modelMenuModelText">
                        <span className="modelMenuItemLabel">{m.label}</span>
                        <span className="modelMenuItemDesc">{m.description}</span>
                      </span>
                      <DropdownMenu.ItemIndicator className="modelMenuIndicator">
                        <MSymbol name="check" size={18} />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
