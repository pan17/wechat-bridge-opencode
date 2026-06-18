/**
 * Unit tests for `formatStatus` in src/adapter/workspace-cmd.ts —
 * specifically the new VCS (git branch) rendering.
 *
 * Covers:
 *   - Both branch and defaultBranch → `🌿 Branch: <b> (default: <d>)`
 *   - Only branch, defaultBranch null → `🌿 Branch: <b>` (no default suffix)
 *   - branch === defaultBranch → `🌿 Branch: <b>` (collapse redundant default)
 *   - branch null, defaultBranch null → `🌿 Branch: (not a git repo)`
 *   - vcs undefined → no Branch line at all (network failure / not fetched)
 *   - vcs null (explicit, not undefined) → still renders "not a git repo"
 *
 * `formatStatus` is a pure function with no side effects, so we can
 * import it directly from the compiled dist artifact without mocking
 * anything. `npm run build` must be run before `npm test` if the
 * source has changed (per vitest.config.mjs).
 */
import { describe, test, expect } from "vitest";
import { formatStatus } from "../../dist/src/adapter/workspace-cmd.js";

/** Minimal valid opts — `formatStatus` requires these keys. */
function baseOpts() {
  return {
    session: { id: "ses_test", cwd: "/tmp/test", title: "Test" },
    workspace: "/tmp/test",
    agent: "build",
    model: "anthropic/claude-sonnet-4-5",
    reasoning: "medium",
    contextUsage: null,
  };
}

describe("formatStatus — VCS branch rendering", () => {
  test("renders both branch and defaultBranch with default suffix", () => {
    const out = formatStatus({
      ...baseOpts(),
      vcs: { branch: "dev", defaultBranch: "main" },
    });
    expect(out).toContain("🌿 Branch: dev (default: main)");
  });

  test("omits default suffix when defaultBranch is null", () => {
    const out = formatStatus({
      ...baseOpts(),
      vcs: { branch: "dev", defaultBranch: null },
    });
    expect(out).toContain("🌿 Branch: dev");
    expect(out).not.toContain("(default:");
  });

  test("collapses redundant default when branch === defaultBranch", () => {
    const out = formatStatus({
      ...baseOpts(),
      vcs: { branch: "main", defaultBranch: "main" },
    });
    expect(out).toContain("🌿 Branch: main");
    expect(out).not.toContain("(default:");
  });

  test("renders 'not a git repo' when both fields are null", () => {
    const out = formatStatus({
      ...baseOpts(),
      vcs: { branch: null, defaultBranch: null },
    });
    expect(out).toContain("🌿 Branch: (not a git repo)");
  });

  test("omits Branch line entirely when vcs is undefined", () => {
    const out = formatStatus(baseOpts());
    expect(out).not.toContain("🌿 Branch:");
  });

  test("explicit null vcs (vs undefined) still renders 'not a git repo'", () => {
    // Defends the contract: undefined = "call failed, skip the line";
    // null = "server returned 200 with nulls, render the placeholder".
    // Both map through the same `opts.vcs` field with different intent.
    const out = formatStatus({
      ...baseOpts(),
      vcs: null,
    });
    expect(out).toContain("🌿 Branch: (not a git repo)");
  });

  test("Branch line appears immediately after the Workspace line", () => {
    const out = formatStatus({
      ...baseOpts(),
      vcs: { branch: "dev", defaultBranch: "main" },
    });
    const workspaceIdx = out.indexOf("📂 Workspace:");
    const branchIdx = out.indexOf("🌿 Branch:");
    expect(workspaceIdx).toBeGreaterThanOrEqual(0);
    expect(branchIdx).toBeGreaterThan(workspaceIdx);
  });
});