import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * ADAAAA-7619 guardrail: the Analysis toolbar's sticky offset is `-top-8`, NOT
 * `top-0`. Its scroll container is Shell's `<main class="flex-1 overflow-y-auto
 * p-8">`, so the scrollport is inset by 2rem; `top-0` left the stuck bar 32px
 * below the window top (the reported bug). `-mx-8 px-8` is the matching bleed
 * so the stuck bar spans the full content area with no see-through strips.
 *
 * This test fails if someone "cleans up" the styling back to `top-0`.
 */
describe("job-detail Analysis toolbar sticks flush to the window top (ADAAAA-7619)", () => {
  const source = readFileSync(resolve(__dirname, "src/pages/JobDetail.tsx"), "utf8");
  const match = source.match(/className="([^"]*)"\s+data-analysis-toolbar/);

  it("sticky offset compensates Shell's p-8 padding", () => {
    expect(match, "data-analysis-toolbar className not found").not.toBeNull();
    const classes = match![1].split(/\s+/);
    expect(classes).toContain("sticky");
    expect(classes).toContain("-top-8");
    expect(classes).not.toContain("top-0");
  });

  it("bleeds over Shell's horizontal padding on both sides", () => {
    const classes = match![1].split(/\s+/);
    expect(classes).toContain("-mx-8");
    expect(classes).toContain("px-8");
    expect(classes).not.toContain("-mx-4");
  });

  it("keeps its stacking layer above the window cards", () => {
    expect(match![1].split(/\s+/)).toContain("z-20");
  });
});
