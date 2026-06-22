/**
 * Regression tests for `SessionManager.getReasoningLevels`.
 *
 * Bug history: `/reasoning list` rendered `(not available)` for any
 * model whose variants used the Anthropic-style `{ thinking: { ... } }`
 * payload instead of the OpenAI-style `{ reasoningEffort: "..." }`
 * payload — even when the model genuinely exposed variants like
 * `{ none: { thinking: { type: "disabled" } }, thinking: { thinking: { type: "adaptive" } } }`
 * (real example: `minimax-cn-coding-plan/MiniMax-M3`).
 *
 * Root cause: the filter hard-required `variants[k].reasoningEffort`,
 * so every Anthropic-style variant was dropped on the floor.
 *
 * Fix: the filter now accepts variants that carry EITHER a
 * `reasoningEffort` field OR a `thinking` field. Display names still
 * fall back to a capitalised variant key when `reasoningEffort` is
 * absent, so `thinking` renders as `Thinking` and `none` renders as
 * `None` — which matches what the server actually exposes.
 *
 * What we verify here:
 *   - OpenAI-style variants (`reasoningEffort`) still surface (no regression).
 *   - Anthropic-style variants (`thinking`) now surface (the bug fix).
 *   - Variant keys with no recognised field are filtered out.
 *   - `reasoning: false` models return [].
 *   - No current model → [].
 *   - `current: true` flag tracks `currentReasoning` correctly across
 *     both variant shapes.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
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

function makeManager() {
  const sm = new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/test/cwd",
    log: () => {},
    onReply: vi.fn().mockResolvedValue(undefined),
    onMediaReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelTyping: vi.fn().mockResolvedValue(undefined),
    onSessionReady: undefined,
  });
  return sm;
}

// ─── Tests ───

describe("SessionManager.getReasoningLevels — OpenAI-style variants", () => {
  test("surfaces all variants with reasoningEffort, plus synthetic Default", () => {
    const sm = makeManager();
    sm.currentModelId = "opencode-go/deepseek-v4-flash";
    sm.availableModels = [
      {
        modelId: "opencode-go/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low" },
          medium: { reasoningEffort: "medium" },
          high: { reasoningEffort: "high" },
          max: { reasoningEffort: "max" },
        },
      },
    ];

    const levels = sm.getReasoningLevels();
    // Synthetic "Default" entry is prepended to mirror OpenCode TUI's
    // dialog-variant.tsx (where "Default" sets variant to undefined,
    // i.e. "let the server pick"). The four real variants follow.
    expect(levels.map((l) => l.value)).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(levels.map((l) => l.name)).toEqual([
      "Default",
      "Low",
      "Medium",
      "High",
      "Max",
    ]);
    // currentReasoning is undefined (fresh start), so the synthetic
    // "Default" entry is the one marked current.
    expect(levels.find((l) => l.value === "default")?.current).toBe(true);
    expect(levels.filter((l) => l.value !== "default").every((l) => l.current === false)).toBe(true);
  });
});

describe("SessionManager.getReasoningLevels — Anthropic-style variants (regression)", () => {
  test("surfaces variants that only have `thinking` (MiniMax-M3 shape), plus Default", () => {
    const sm = makeManager();
    sm.currentModelId = "minimax-cn-coding-plan/MiniMax-M3";
    sm.availableModels = [
      {
        modelId: "minimax-cn-coding-plan/MiniMax-M3",
        name: "MiniMax-M3",
        reasoning: true,
        variants: {
          none: { thinking: { type: "disabled" } },
          thinking: { thinking: { type: "adaptive" } },
        },
      },
    ];

    const levels = sm.getReasoningLevels();
    // Both real variants show up — the whole point of the original
    // Anthropic-style fix — plus the synthetic "Default" entry at
    // position 0 (TUI parity).
    expect(levels.map((l) => l.value)).toEqual(["default", "none", "thinking"]);
    // No reasoningEffort → fall back to capitalised variant key.
    expect(levels.map((l) => l.name)).toEqual(["Default", "None", "Thinking"]);
    // currentReasoning is undefined → "Default" is current.
    expect(levels.find((l) => l.value === "default")?.current).toBe(true);
  });

  test("accepts a single Anthropic-style variant, plus Default", () => {
    const sm = makeManager();
    sm.currentModelId = "anthropic/claude-sonnet-4-5";
    sm.availableModels = [
      {
        modelId: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        variants: {
          thinking: { thinking: { type: "enabled", budget: 8192 } },
        },
      },
    ];

    const levels = sm.getReasoningLevels();
    expect(levels).toEqual([
      { value: "default", name: "Default", current: true },
      { value: "thinking", name: "Thinking", current: false },
    ]);
  });

  test("mixed variant set — keeps both shapes, drops unrecognised keys, plus Default", () => {
    const sm = makeManager();
    sm.currentModelId = "future/model";
    sm.availableModels = [
      {
        modelId: "future/model",
        name: "Future",
        reasoning: true,
        variants: {
          // OpenAI-style — kept
          high: { reasoningEffort: "high" },
          // Anthropic-style — now also kept (was the bug)
          thinking: { thinking: { type: "adaptive" } },
          // No recognised field — filtered out
          unknown: {},
          // Empty value — filtered out (undefined fields)
          empty: {},
        },
      },
    ];

    const levels = sm.getReasoningLevels();
    // Set comparison — synthetic "Default" entry is always prepended,
    // but the rest are object-key order so we don't pin exact ordering.
    const values = levels.map((l) => l.value);
    expect(values).toContain("default");
    expect(values.filter((v) => v !== "default").sort()).toEqual(["high", "thinking"]);
  });
});

describe("SessionManager.getReasoningLevels — empty / negative cases", () => {
  test("returns [] when there is no current model", () => {
    const sm = makeManager();
    // No currentModelId set, no availableModels.
    expect(sm.getReasoningLevels()).toEqual([]);
  });

  test("returns [] when reasoning capability is explicitly false", () => {
    const sm = makeManager();
    sm.currentModelId = "foo/non-reasoning";
    sm.availableModels = [
      {
        modelId: "foo/non-reasoning",
        name: "Non-Reasoning",
        reasoning: false,
        variants: {
          low: { reasoningEffort: "low" }, // even though it has one
        },
      },
    ];
    expect(sm.getReasoningLevels()).toEqual([]);
  });

  test("returns [] when model has no variants at all", () => {
    const sm = makeManager();
    sm.currentModelId = "opencode-go/qwen3.7-plus";
    sm.availableModels = [
      {
        modelId: "opencode-go/qwen3.7-plus",
        name: "Qwen3.7 Plus",
        reasoning: true,
        variants: {}, // empty
      },
    ];
    expect(sm.getReasoningLevels()).toEqual([]);
  });

  test("returns [] when current model id is not in the available models list", () => {
    const sm = makeManager();
    sm.currentModelId = "ghost/nonexistent";
    sm.availableModels = [
      {
        modelId: "opencode-go/mimo-v2.5",
        name: "MiMo V2.5",
        reasoning: true,
        variants: { low: { reasoningEffort: "low" } },
      },
    ];
    expect(sm.getReasoningLevels()).toEqual([]);
  });
});

describe("SessionManager.getReasoningLevels — `current` flag", () => {
  test("marks the matching variant as current (OpenAI-style)", () => {
    const sm = makeManager();
    sm.currentModelId = "opencode-go/deepseek-v4-flash";
    sm.availableModels = [
      {
        modelId: "opencode-go/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        variants: {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        },
      },
    ];
    sm.currentReasoning = "high";

    const levels = sm.getReasoningLevels();
    expect(levels.find((l) => l.value === "high")?.current).toBe(true);
    expect(levels.find((l) => l.value === "low")?.current).toBe(false);
  });

  test("marks the matching variant as current (Anthropic-style)", () => {
    const sm = makeManager();
    sm.currentModelId = "minimax-cn-coding-plan/MiniMax-M3";
    sm.availableModels = [
      {
        modelId: "minimax-cn-coding-plan/MiniMax-M3",
        name: "MiniMax-M3",
        reasoning: true,
        variants: {
          none: { thinking: { type: "disabled" } },
          thinking: { thinking: { type: "adaptive" } },
        },
      },
    ];
    sm.currentReasoning = "thinking";

    const levels = sm.getReasoningLevels();
    expect(levels.find((l) => l.value === "thinking")?.current).toBe(true);
    expect(levels.find((l) => l.value === "none")?.current).toBe(false);
  });
});