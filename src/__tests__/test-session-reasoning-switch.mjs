/**
 * Regression tests for `SessionManager.setReasoning` (and the
 * `getReasoningLevels` <-> `setReasoning` dual-shape contract).
 *
 * Bug history: `/reasoning list` and `/reasoning switch` were
 * asymmetric. `getReasoningLevels` (list) was patched to accept BOTH
 * variant shapes the OpenCode Server can return:
 *
 *   - OpenAI-style:    `{ reasoningEffort: "low"|"medium"|"high" }`
 *   - Anthropic-style: `{ thinking: { type: "enabled"|"adaptive"|"disabled" } }`
 *
 * …but `setReasoning` (switch) was NOT — its `known` filter hard-required
 * `variants[k]?.reasoningEffort`, so Anthropic-style models like
 * `minimax-cn-coding-plan/MiniMax-M3` (which expose
 * `{ none: { thinking: { type: "disabled" } }, thinking: { thinking: { type: "adaptive" } } }`)
 * would list their levels in `/reasoning list` and then reject every
 * switch attempt with `Unknown reasoning level "…". Available: ` (the
 * "Available:" suffix was empty because `known` was empty).
 *
 * Fix:
 *   1. Introduced a `VariantPayload` type alias + `isReasoningVariant()`
 *      helper used by BOTH list and switch, so the two methods can
 *      never drift again.
 *   2. `setReasoning` now also accepts `thinking.type` as a match
 *      target (so users can switch by `enabled` / `adaptive` /
 *      `disabled` instead of an opaque variant key).
 *   3. The error message now renders `reasoningEffort` OR `thinking.type`
 *      OR the variant key as the display label, so the user always sees
 *      something useful in the "Available:" list.
 *   4. `resolveReasoningName` (display name) now also reads
 *      `thinking.type` for the Anthropic shape.
 *
 * What we verify here:
 *   - OpenAI-style switch still works (no regression on the original path).
 *   - Anthropic-style switch works (the bug fix).
 *   - `thinking.type` value (e.g. "adaptive") can be used as a switch
 *     target — not just the opaque variant key.
 *   - Match is case-insensitive.
 *   - Unknown levels still throw — but the "Available:" list now
 *     contains useful labels (not an empty string) for Anthropic models.
 *   - The "default" sentinel still clears `currentReasoning`.
 *   - `setReasoning` is a no-op-validate when no model is loaded
 *     (variants table absent) — store verbatim, don't throw.
 *   - `setReasoning` then `getReasoningLevels` agree on the `current`
 *     flag for both shapes.
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

// ─── Anthropic-style (the regression) ───

describe("SessionManager.setReasoning — Anthropic-style variants (regression)", () => {
  test("switches to a variant key on a thinking-only model (MiniMax-M3 shape)", async () => {
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

    // Before the fix, this threw:
    //   "Unknown reasoning level "none" for … Available: "
    await expect(sm.setReasoning("none")).resolves.toBeUndefined();
    expect(sm.getCurrentReasoning()).toBe("none");
    // Display name uses the variant key fallback (no reasoningEffort) so
    // M3 shows "None" / "Thinking" — matches the existing user-visible
    // /reasoning list output and the /status line.
    expect(sm.getCurrentReasoningDisplay()).toBe("None");
  });

  test("switches to a thinking variant by its `thinking.type` value", async () => {
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

    // User can type the inner `thinking.type` value instead of the
    // variant key — covers the case where the model exposes multiple
    // "thinking" slots that the user might want to disambiguate by
    // their inner type label.
    await sm.setReasoning("adaptive");
    // CRITICAL: `currentReasoning` stores the MATCHED variant key
    // ("thinking"), not the user's literal input ("adaptive"). The
    // server only accepts variant keys, not display labels.
    expect(sm.getCurrentReasoning()).toBe("thinking");
    expect(sm.getCurrentReasoningDisplay()).toBe("Thinking");
  });

  test("match is case-insensitive for both variant key and thinking.type", async () => {
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

    await sm.setReasoning("THINKING");
    expect(sm.getCurrentReasoning()).toBe("thinking");

    await sm.setReasoning("Adaptive");
    // "Adaptive" matches `thinking.type` for the `thinking` variant, so
    // the matched key is stored (not the literal "Adaptive").
    expect(sm.getCurrentReasoning()).toBe("thinking");
  });

  test("switch + list agree on the `current` flag (Anthropic shape)", async () => {
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

    await sm.setReasoning("none");
    const levels = sm.getReasoningLevels();
    const noneLevel = levels.find((l) => l.value === "none");
    const thinkingLevel = levels.find((l) => l.value === "thinking");
    expect(noneLevel?.current).toBe(true);
    expect(thinkingLevel?.current).toBe(false);
  });

  test("unknown level on Anthropic model throws with a useful 'Available' list (not empty)", async () => {
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

    // Before the fix: "Available: " (empty). After: "Available: none (disabled), thinking (adaptive)".
    let caught;
    try {
      await sm.setReasoning("ultra");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain('Unknown reasoning level "ultra"');
    expect(caught.message).toContain("none (disabled)");
    expect(caught.message).toContain("thinking (adaptive)");
    // `currentReasoning` must NOT have been mutated by a failed switch.
    expect(sm.getCurrentReasoning()).toBeUndefined();
  });
});

// ─── OpenAI-style (no regression) ───

describe("SessionManager.setReasoning — OpenAI-style variants (no regression)", () => {
  test("switches to a variant by key", async () => {
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
        },
      },
    ];

    await sm.setReasoning("high");
    expect(sm.getCurrentReasoning()).toBe("high");
    expect(sm.getCurrentReasoningDisplay()).toBe("High");
  });

  test("switches to a variant by reasoningEffort value (case-insensitive)", async () => {
    const sm = makeManager();
    sm.currentModelId = "opencode-go/deepseek-v4-flash";
    sm.availableModels = [
      {
        modelId: "opencode-go/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        variants: {
          one: { reasoningEffort: "low" },
          two: { reasoningEffort: "medium" },
          three: { reasoningEffort: "high" },
        },
      },
    ];

    // User types the reasoningEffort value, not the opaque "one" key.
    await sm.setReasoning("MEDIUM");
    // CRITICAL: must store the matched variant key ("two"), not the
    // user's literal "MEDIUM" — the server only accepts variant keys.
    expect(sm.getCurrentReasoning()).toBe("two");
    expect(sm.getCurrentReasoningDisplay()).toBe("Medium");
  });

  test("unknown level on OpenAI model still throws", async () => {
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

    let caught;
    try {
      await sm.setReasoning("ultra");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain("low (low)");
    expect(caught.message).toContain("high (high)");
  });
});

// ─── Mixed variants ───

describe("SessionManager.setReasoning — mixed OpenAI + Anthropic variants", () => {
  test("matches both shapes in the same model", async () => {
    const sm = makeManager();
    sm.currentModelId = "future/hybrid-model";
    sm.availableModels = [
      {
        modelId: "future/hybrid-model",
        name: "Hybrid",
        reasoning: true,
        variants: {
          // OpenAI-style
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
          // Anthropic-style
          think: { thinking: { type: "adaptive" } },
          // Empty — should be ignored, not match anything
          empty: {},
        },
      },
    ];

    // Switch by reasoningEffort value (low).
    await sm.setReasoning("low");
    expect(sm.getCurrentReasoning()).toBe("low");

    // Switch by thinking.type value (adaptive) — distinct from the
    // reasoningEffort values, so this MUST match only `think`.
    await sm.setReasoning("adaptive");
    // Matched via thinking.type → store the variant key, not the literal.
    expect(sm.getCurrentReasoning()).toBe("think");

    // Switch by variant key (high) — direct key match.
    await sm.setReasoning("high");
    expect(sm.getCurrentReasoning()).toBe("high");
  });
});

// ─── `default` sentinel and edge cases ───

describe("SessionManager.setReasoning — `default` sentinel and edge cases", () => {
  test("`default` clears currentReasoning (lets server pick)", async () => {
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

    await sm.setReasoning("thinking");
    expect(sm.getCurrentReasoning()).toBe("thinking");
    await sm.setReasoning("default");
    expect(sm.getCurrentReasoning()).toBeUndefined();
  });

  test("no model loaded → stores verbatim, no throw (deferred validation)", async () => {
    // When `refreshProviders` hasn't run yet, `availableModels` is empty
    // and `getCurrentReasoningModel()` returns undefined. We can't
    // validate against a variants table we don't have, so we accept the
    // value verbatim and let the next sync re-validate.
    const sm = makeManager();
    // No currentModelId, no availableModels.
    await expect(sm.setReasoning("thinking")).resolves.toBeUndefined();
    expect(sm.getCurrentReasoning()).toBe("thinking");
  });

  test("unknown level does not mutate currentReasoning", async () => {
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

    // Start with a known value, then try an unknown one.
    await sm.setReasoning("none");
    expect(sm.getCurrentReasoning()).toBe("none");

    await expect(sm.setReasoning("nonsense")).rejects.toThrow(/Unknown reasoning level/);
    // Must still be "none" — failed validation must NOT overwrite state.
    expect(sm.getCurrentReasoning()).toBe("none");
  });
});
