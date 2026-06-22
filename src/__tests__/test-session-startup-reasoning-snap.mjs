/**
 * Regression tests for the `currentReasoning` state on bridge startup
 * and after session/workspace switches.
 *
 * Background — two related bugs surfaced over time:
 *
 *   1. **Bug A (now superseded)**: fresh bridge start left
 *      `currentReasoning` undefined even when the default model had
 *      reasoning variants, so `/status` showed `Reasoning: (not set)`
 *      and the next prompt's `variant` parameter was undefined —
 *      letting the server pick its own default silently.
 *
 *   2. **Bug A's flawed fix**: snapping undefined → first variant
 *      key changed the user's effective reasoning behaviour without
 *      their consent. For `minimax-cn-coding-plan/MiniMax-M3`, the
 *      variants dict is `{none, thinking}` (alphabetical / insertion
 *      order), so the first key is `"none"` — but the server's
 *      default for M3 is `"thinking"`. A TUI session that was created
 *      with the "Default" option (variant=undefined → server picks
 *      thinking) would, after the bridge switch-back, suddenly be
 *      `none`. Wrong direction.
 *
 * **Current behaviour**: `currentReasoning` is NEVER auto-snapped.
 * `undefined` is the legitimate "Default" state meaning "let the
 * server pick" (mirrors OpenCode TUI's `dialog-variant.tsx` synthetic
 * "Default" entry). `/reasoning list` shows the synthetic entry;
 * `/status` displays `Reasoning: Default`; the next prompt omits
 * `variant` and the server applies its model default. Users who want
 * a specific level `/reasoning switch <level>`.
 *
 * **Helper that survived**: `clearReasoningIfModelHasNoVariants`
 * still fires in both `setModel` and `refreshProviders` — but ONLY
 * to clear a stale `currentReasoning` when the freshly-populated
 * model genuinely has no reasoning variants. It does not snap.
 *
 * What we verify here:
 *   - Fresh `refreshProviders` leaves `currentReasoning` undefined
 *     when the default model has variants (no auto-snap to first).
 *   - Fresh `refreshProviders` clears a stale `currentReasoning`
 *     when the default model has NO variants.
 *   - Fresh `refreshProviders` does NOT touch `currentReasoning`
 *     when it was already valid for the freshly-populated model.
 *   - The synthetic "Default" entry appears at position 0 of
 *     `getReasoningLevels()` and is marked `current: true` when
 *     `currentReasoning === undefined`.
 *   - `setReasoning("default")` sets `currentReasoning` to undefined
 *     (the explicit user-driven path, separate from auto-behaviour).
 *   - `getCurrentReasoningDisplay()` returns `"Default"` (not
 *     `"(not set)"`) when `currentReasoning === undefined`, so
 *     `/status` reads consistently with `/reasoning list`.
 *   - `setModel` clears reasoning when switching to a no-variants
 *     model, and leaves it alone when switching to a variants model
 *     even if the old value isn't in the new table.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ─── Mock the OpenCodeServerClient module ───
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    listProviders: vi.fn(),
    getConfig: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([]),
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
    getAuthHeader: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../../dist/src/server/client.js", () => ({
  OpenCodeServerClient: class {
    constructor() {
      return clientMock;
    }
  },
}));

import { SessionManager } from "../../dist/src/server/session.js";

beforeEach(() => {
  clientMock.listProviders.mockReset();
  clientMock.getConfig.mockReset();
  clientMock.listAgents.mockReset();
  clientMock.listProviders.mockResolvedValue([]);
  clientMock.getConfig.mockResolvedValue({});
});

function makeManager() {
  return new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/test/cwd",
    log: () => {},
    onReply: vi.fn().mockResolvedValue(undefined),
    onMediaReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelTyping: vi.fn().mockResolvedValue(undefined),
    onSessionReady: undefined,
  });
}

// ─── Tests: refreshProviders no longer auto-snaps ───

describe("SessionManager.refreshProviders — no auto-snap (preserves Default semantics)", () => {
  test("leaves currentReasoning undefined after startup (model with variants)", async () => {
    // The whole reason this file exists: the previous behaviour
    // snapped `undefined` → first variant key (often "none" for
    // Anthropic-style models), silently overriding the user's
    // implicit "Default" choice. Now we leave it alone so the next
    // prompt omits `variant` and the server applies its own default.
    clientMock.listProviders.mockResolvedValue([
      {
        id: "minimax-cn-coding-plan",
        name: "MiniMax Token Plan",
        models: [
          {
            id: "MiniMax-M3",
            capabilities: { reasoning: true },
            variants: {
              none: { thinking: { type: "disabled" } },
              thinking: { thinking: { type: "adaptive" } },
            },
          },
        ],
      },
    ]);
    clientMock.getConfig.mockResolvedValue({ model: "minimax-cn-coding-plan/MiniMax-M3" });

    const m = makeManager();
    expect(m.currentReasoning).toBeUndefined(); // sanity check
    await m.refreshProviders();

    expect(m.currentModelId).toBe("minimax-cn-coding-plan/MiniMax-M3");
    // The fix: undefined STAYS undefined — display layer will show "Default".
    expect(m.currentReasoning).toBeUndefined();
  });

  test("leaves currentReasoning undefined after fallback to first available model", async () => {
    // No config.model → refreshProviders picks the first available
    // model. Even then, currentReasoning stays undefined so the
    // synthetic "Default" entry is the one marked current in
    // /reasoning list (TUI parity).
    clientMock.listProviders.mockResolvedValue([
      {
        id: "opencode-go",
        name: "OpenCode Go",
        models: [
          {
            id: "deepseek-v4-flash",
            capabilities: { reasoning: true },
            variants: {
              low: { reasoningEffort: "low" },
              medium: { reasoningEffort: "medium" },
              high: { reasoningEffort: "high" },
            },
          },
        ],
      },
    ]);
    clientMock.getConfig.mockResolvedValue({}); // no model

    const m = makeManager();
    await m.refreshProviders();

    expect(m.currentModelId).toBe("opencode-go/deepseek-v4-flash");
    expect(m.currentReasoning).toBeUndefined();
  });

  test("preserves an already-valid currentReasoning for the new model (idempotent)", async () => {
    // Simulate a previous session setting `currentReasoning = "high"`
    // and the bridge restarting with the same model as default. The
    // refresh must NOT clobber that value.
    clientMock.listProviders.mockResolvedValue([
      {
        id: "opencode-go",
        name: "OpenCode Go",
        models: [
          {
            id: "deepseek-v4-flash",
            capabilities: { reasoning: true },
            variants: {
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
            },
          },
        ],
      },
    ]);
    clientMock.getConfig.mockResolvedValue({ model: "opencode-go/deepseek-v4-flash" });

    const m = makeManager();
    m.currentReasoning = "high"; // pre-existing valid value
    await m.refreshProviders();

    expect(m.currentReasoning).toBe("high"); // untouched
  });

  test("clears stale currentReasoning when the new model has no variants", async () => {
    // If the workspace's default model is non-reasoning but we still
    // have a stale `currentReasoning` from a previous reasoning-
    // capable session, the refresh should clear it so the next prompt
    // doesn't send a `variant` the server can't honour.
    clientMock.listProviders.mockResolvedValue([
      {
        id: "opencode-go",
        name: "OpenCode Go",
        models: [
          {
            id: "qwen3.7-plus",
            capabilities: { reasoning: true },
            // No `variants` key — server says this model exposes none.
          },
        ],
      },
    ]);
    clientMock.getConfig.mockResolvedValue({ model: "opencode-go/qwen3.7-plus" });

    const m = makeManager();
    m.currentReasoning = "high"; // stale from a previous session
    await m.refreshProviders();

    expect(m.currentModelId).toBe("opencode-go/qwen3.7-plus");
    expect(m.currentReasoning).toBeUndefined();
  });

  test("does NOT clear currentReasoning when it is already undefined (avoids spurious notes)", async () => {
    // Even when the model has no variants, undefined is undefined —
    // no transition to log, no reason to emit a "cleared" note.
    clientMock.listProviders.mockResolvedValue([
      {
        id: "opencode-go",
        name: "OpenCode Go",
        models: [
          {
            id: "qwen3.7-plus",
            capabilities: { reasoning: true },
            // no variants
          },
        ],
      },
    ]);
    clientMock.getConfig.mockResolvedValue({ model: "opencode-go/qwen3.7-plus" });

    const m = makeManager();
    // currentReasoning is already undefined (constructor default).
    await m.refreshProviders();

    expect(m.currentReasoning).toBeUndefined();
  });
});

// ─── Tests: getReasoningLevels synthetic Default entry ───

describe("SessionManager.getReasoningLevels — synthetic Default entry", () => {
  test("prepends Default entry that is current when currentReasoning is undefined", () => {
    const m = makeManager();
    m.currentModelId = "minimax-cn-coding-plan/MiniMax-M3";
    m.availableModels = [
      {
        modelId: "minimax-cn-coding-plan/MiniMax-M3",
        reasoning: true,
        variants: {
          none: { thinking: { type: "disabled" } },
          thinking: { thinking: { type: "adaptive" } },
        },
      },
    ];

    const levels = m.getReasoningLevels();
    expect(levels[0]).toEqual({ value: "default", name: "Default", current: true });
    expect(levels[1].value).toBe("none");
    expect(levels[2].value).toBe("thinking");
  });

  test("Default entry is NOT current when user has explicitly chosen a level", () => {
    const m = makeManager();
    m.currentModelId = "minimax-cn-coding-plan/MiniMax-M3";
    m.availableModels = [
      {
        modelId: "minimax-cn-coding-plan/MiniMax-M3",
        reasoning: true,
        variants: {
          none: { thinking: { type: "disabled" } },
          thinking: { thinking: { type: "adaptive" } },
        },
      },
    ];
    m.currentReasoning = "thinking"; // explicit choice

    const levels = m.getReasoningLevels();
    expect(levels.find((l) => l.value === "default")?.current).toBe(false);
    expect(levels.find((l) => l.value === "thinking")?.current).toBe(true);
  });

  test("does NOT prepend Default when model has no variants (model can't reason)", () => {
    // A model that exposes no reasoning variants should not show a
    // "Default" option — there's no reasoning to opt into or out of.
    const m = makeManager();
    m.currentModelId = "opencode-go/qwen3.7-plus";
    m.availableModels = [
      {
        modelId: "opencode-go/qwen3.7-plus",
        reasoning: true,
        variants: {}, // empty
      },
    ];

    expect(m.getReasoningLevels()).toEqual([]);
  });
});

// ─── Tests: getCurrentReasoningDisplay ───

describe("SessionManager.getCurrentReasoningDisplay — Default string", () => {
  test("returns 'Default' when currentReasoning is undefined (matches TUI + /reasoning list)", () => {
    const m = makeManager();
    m.currentModelId = "minimax-cn-coding-plan/MiniMax-M3";
    m.availableModels = [
      {
        modelId: "minimax-cn-coding-plan/MiniMax-M3",
        reasoning: true,
        variants: {
          none: { thinking: { type: "disabled" } },
          thinking: { thinking: { type: "adaptive" } },
        },
      },
    ];
    expect(m.getCurrentReasoningDisplay()).toBe("Default");
  });

  test("resolves the model-specific display name when currentReasoning is set", () => {
    const m = makeManager();
    m.currentModelId = "opencode-go/deepseek-v4-flash";
    m.availableModels = [
      {
        modelId: "opencode-go/deepseek-v4-flash",
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        },
      },
    ];
    m.currentReasoning = "high";
    expect(m.getCurrentReasoningDisplay()).toBe("High");
  });
});

// ─── Tests: setReasoning("default") explicit path ───

describe("SessionManager.setReasoning — explicit 'default' path", () => {
  test("/reasoning switch default sets currentReasoning to undefined", async () => {
    const m = makeManager();
    m.currentModelId = "minimax-cn-coding-plan/MiniMax-M3";
    m.availableModels = [
      {
        modelId: "minimax-cn-coding-plan/MiniMax-M3",
        reasoning: true,
        variants: {
          none: { thinking: { type: "disabled" } },
          thinking: { thinking: { type: "adaptive" } },
        },
      },
    ];
    m.currentReasoning = "thinking"; // start from an explicit choice

    await m.setReasoning("default");
    expect(m.currentReasoning).toBeUndefined();
  });

  test("/reasoning switch DEFAULT (case-insensitive) also works", async () => {
    const m = makeManager();
    m.currentModelId = "minimax-cn-coding-plan/MiniMax-M3";
    m.availableModels = [
      {
        modelId: "minimax-cn-coding-plan/MiniMax-M3",
        reasoning: true,
        variants: {
          thinking: { thinking: { type: "adaptive" } },
        },
      },
    ];
    m.currentReasoning = "thinking";

    await m.setReasoning("DEFAULT");
    expect(m.currentReasoning).toBeUndefined();
  });
});

// ─── Tests: setModel regression guard ───

describe("SessionManager.setModel — clearing behaviour preserved", () => {
  test("clears reasoning when switching to a model with no variants", async () => {
    const m = makeManager();
    m.availableModels = [
      {
        modelId: "simple/no-variants",
        reasoning: false,
        // no `variants` field
      },
    ];
    m.currentModelId = "old/thinking-model";
    m.currentReasoning = "high";

    const result = await m.setModel("simple/no-variants");

    expect(m.currentReasoning).toBeUndefined();
    expect(result.note).toMatch(/Reasoning cleared/);
  });

  test("does NOT snap to first variant when the old reasoning is invalid for the new model", async () => {
    // The previous (buggy) behaviour snapped `currentReasoning` to
    // the first variant key whenever it wasn't in the new model's
    // table. We now LEAVE IT ALONE so the user keeps their explicit
    // choice — if it turns out the server can't honour it, the next
    // prompt will surface the mismatch and the user can fix it.
    const m = makeManager();
    m.availableModels = [
      {
        modelId: "anthropic/claude-sonnet-4-5",
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        },
      },
    ];
    m.currentModelId = "opencode-go/legacy-model";
    m.currentReasoning = "ultra-mega"; // not valid on the new model

    const result = await m.setModel("anthropic/claude-sonnet-4-5");

    expect(m.currentModelId).toBe("anthropic/claude-sonnet-4-5");
    expect(m.currentReasoning).toBe("ultra-mega"); // preserved, not snapped
    expect(result.note).toBeUndefined(); // no transition note
  });
});
