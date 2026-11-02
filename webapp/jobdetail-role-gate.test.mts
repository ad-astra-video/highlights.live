import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * ADAAAA-7737 guardrail: the routed page (/app/jobs/:id) must thread the session
 * role into every surface that can render pipeline internals, and must render
 * the customer projection for a non-admin session.
 *
 * The render-boundary tests in `src/pages/JobDetail.customer.test.tsx` pin what
 * each surface does with `admin={false}`; this test pins that the PAGE actually
 * passes it. Without this, a later edit could drop one `admin={admin}` and
 * silently re-leak the customer view (exactly how ADAAAA-7727's AC1 failed:
 * the components were gated, the routed page was not).
 */
describe("job detail threads the session role into every leaking surface (ADAAAA-7737)", () => {
  const source = readFileSync(resolve(__dirname, "src/pages/JobDetail.tsx"), "utf8");

  it("passes admin={admin} to every component that can render internals", () => {
    // JobDetailMetrics, AnalysisWindow, HighlightCard (2 call sites),
    // SecondaryHighlightLane (2 call sites).
    const passes = source.match(/admin=\{admin\}/g) ?? [];
    expect(passes.length).toBeGreaterThanOrEqual(6);
    for (const component of ["<JobDetailMetrics", "<AnalysisWindow"]) {
      const idx = source.indexOf(component);
      expect(idx, `${component} call site missing`).toBeGreaterThan(-1);
      const callSite = source.slice(idx, source.indexOf("/>", idx));
      expect(callSite, `${component} must receive admin={admin}`).toContain("admin={admin}");
    }
  });

  it("renders the customer projection of Analysis for a non-admin session", () => {
    expect(source).toContain("CustomerAnalysisSection sections={detail.sections}");
    // The operator toolbar (filter chips + search + select/enlarge) is inside
    // the admin branch of the analysis section.
    const sectionIdx = source.indexOf('data-analysis-section');
    const branch = source.slice(sectionIdx, source.indexOf("</div>", source.length - 1));
    expect(branch).toContain("{admin ? (");
  });

  it("keeps the rejected lane and the decide audit admin-only", () => {
    expect(source).toContain('{admin && detail.highlights.filter((h) => h.status === "rejected")');
    expect(source).toContain("{admin && (\n            <div className=\"mt-8\" data-decide-audit-section>");
  });
});
