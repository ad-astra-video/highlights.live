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
    // JobDetailMetrics, AnalysisWindow, HighlightCard (call sites),
    // SecondaryHighlightLane (2 call sites), CostTimePanel/Toggle (ADAAAA-7929).
    const passes = source.match(/admin=\{admin\}/g) ?? [];
    expect(passes.length).toBeGreaterThanOrEqual(6);
    // `<AnalysisWindow\n` — matching the bare prefix would land on
    // `<AnalysisWindowList`, which is the list wrapper and takes no admin prop.
    for (const component of ["<JobDetailMetrics", "<AnalysisWindow\n"]) {
      const idx = source.indexOf(component);
      expect(idx, `${component} call site missing`).toBeGreaterThan(-1);
      const callSite = source.slice(idx, source.indexOf("/>", idx));
      expect(callSite, `${component} must receive admin={admin}`).toContain("admin={admin}");
    }
  });

  it("renders the customer projection of Analysis for a non-admin session", () => {
    expect(source).toContain("<CustomerAnalysisSection");
    expect(source).toContain("sections={detail.sections}");
    // The operator toolbar (filter chips + search + select/enlarge) is the
    // `{admin ? (` arm of the Analysis section; the customer projection is the
    // `) : (` arm after it.
    const sectionIdx = source.indexOf("data-analysis-section");
    expect(sectionIdx).toBeGreaterThan(-1);
    const branch = source.slice(sectionIdx, sectionIdx + 6000);
    expect(branch).toContain("{admin ? (");
    expect(branch).toContain(") : (");
    expect(branch.indexOf("{admin ? (")).toBeLessThan(branch.indexOf(") : ("));
  });

  it("keeps the rejected rows and the decide audit honest about their role", () => {
    // ADAAAA-7915: a customer can undo a misclick, so the hidden-reject strip
    // renders for BOTH roles — but it is fed from the raw rows, never from the
    // postable projection, and the postable list never carries a rejected row.
    expect(source).toContain('detail.highlights.filter((h) => h.status !== "rejected")');
    expect(source).toContain("rejectedStripRows(rawHighlights, detail?.highlights)");
    // The decide audit stays admin-only (raw prompts / verdicts / media hashes).
    expect(source).toContain("{admin && (\n            <div className=\"mt-8\" data-decide-audit-section>");
  });
});

/**
 * ADAAAA-7929 (Inc 2 of ADAAAA-7925, AC1/AC12): the `Cost & time` control is an
 * admin-gated internal (ADAAAA-7727), and it must be a sibling of `See detail`
 * in the ADMIN Analysis toolbar — never on the owner-facing surface. The
 * component-level render tests pin `admin={false}` → nothing; this pins where the
 * page actually mounts it, so a later edit cannot drop the gate or move the
 * button onto the customer toolbar.
 */
describe("the VOD cost & time panel mounts only on the admin Analysis toolbar (ADAAAA-7929)", () => {
  const source = readFileSync(resolve(__dirname, "src/pages/JobDetail.tsx"), "utf8");
  const sectionIdx = source.indexOf("data-analysis-section");
  const adminBranchIdx = source.indexOf("{admin ? (", sectionIdx);
  const customerArmIdx = source.indexOf(") : (", adminBranchIdx);
  const toggleIdx = source.indexOf("<CostTimeToggle");
  const panelIdx = source.indexOf("<CostTimePanel");

  it("renders the toggle exactly once, immediately left of See detail", () => {
    expect((source.match(/<CostTimeToggle/g) ?? []).length).toBe(1);
    const toggleEnd = source.indexOf("/>", toggleIdx);
    const seeDetailIdx = source.indexOf("<SeeDetailToggle", toggleEnd);
    expect(toggleIdx).toBeGreaterThan(-1);
    expect(seeDetailIdx).toBeGreaterThan(toggleEnd);
    // nothing but whitespace/comments sits between the two buttons
    const between = source
      .slice(toggleEnd + 2, seeDetailIdx)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\s*\}/g, "")
      .trim();
    expect(between).toBe("");
  });

  it("mounts both the toggle and the panel inside the admin branch of Analysis", () => {
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(adminBranchIdx).toBeGreaterThan(sectionIdx);
    expect(toggleIdx).toBeGreaterThan(adminBranchIdx);
    expect(panelIdx).toBeGreaterThan(adminBranchIdx);
  });

  it("never reaches the owner-facing (customer) Analysis projection", () => {
    expect(customerArmIdx).toBeGreaterThan(adminBranchIdx);
    expect(toggleIdx).toBeLessThan(customerArmIdx);
    expect(panelIdx).toBeLessThan(customerArmIdx);
  });

  it("threads admin into both halves and defaults the panel CLOSED (no fetch on load)", () => {
    const toggleSite = source.slice(toggleIdx, source.indexOf("/>", toggleIdx));
    expect(toggleSite).toContain("admin={admin}");
    const panelSite = source.slice(panelIdx, source.indexOf("/>", panelIdx));
    expect(panelSite).toContain("admin={admin}");
    expect(panelSite).toContain("jobId={detail.job.id}");
    expect(source).toContain("const [costTimeOpen, setCostTimeOpen] = useState(false);");
    // rendered only while toggled on, so the fetch happens on open (spec §5)
    expect(source).toContain("{costTimeOpen && (");
  });
});
