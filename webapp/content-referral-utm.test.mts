import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect } from "vitest";
import React from "react";
import { ContentReferral } from "./src/pages/ContentReferral";
import { Landing } from "./src/pages/Landing";
import { AuthProvider } from "./src/lib/auth";

// ADAAAA-6384 launch leg: the content-referral explainer at /creators-2026 is
// the first launch placement. It must carry 2-4 in-page placements that share
// utm_source=content_referral / utm_medium=page / utm_campaign=creators-2026 and
// differ only in utm_content, so /admin/funnel + /admin/spend can attribute a
// conversion to the placement that produced it. This guards against a refactor
// collapsing the page back to a single tag set.

function renderPage(El: React.ComponentType, entry = "/creators-2026") {
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, { path: "/creators-2026", element: React.createElement(El) })
      )
    )
  );
}

/** Every href on the page that carries a UTM set, as [href, URLSearchParams]. */
function utmLinks(html: string): Array<[string, URLSearchParams]> {
  const out: Array<[string, URLSearchParams]> = [];
  const re = /href="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].replace(/&amp;/g, "&");
    if (!raw.includes("utm_")) continue;
    const [, search] = raw.split("?");
    out.push([raw, new URLSearchParams(search ?? "")]);
  }
  return out;
}

describe("content-referral placement UTM tags (ADAAAA-6384)", () => {
  const html = renderPage(ContentReferral);

  it("renders the explainer page", () => {
    expect(html).toContain("Feed it your stream");
  });

  it("exposes 2-4 distinct utm_content placements", () => {
    const contents = new Set(utmLinks(html).map(([, p]) => p.get("utm_content")));
    expect(contents.size).toBe(4);
    expect([...contents].sort()).toEqual(
      ["creators-auth", "creators-footer", "creators-hero", "creators-mid"]
    );
    // the pre-launch single-tag value must be gone
    expect(contents.has("explainer")).toBe(false);
  });

  it("keeps source/medium/campaign consistent on every tagged link", () => {
    const links = utmLinks(html);
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const [href, p] of links) {
      expect(href.startsWith("/")).toBe(true);
      expect(p.get("utm_source")).toBe("content_referral");
      expect(p.get("utm_medium")).toBe("page");
      expect(p.get("utm_campaign")).toBe("creators-2026");
      expect(p.get("utm_content")).toBeTruthy();
    }
  });

  it("routes every placement into the live funnel (landing or signup)", () => {
    const targets = new Set(utmLinks(html).map(([href]) => href.split("?")[0]));
    expect([...targets].sort()).toEqual(["/", "/auth"]);
  });
});

describe("landing page is an inbound surface for the placement (ADAAAA-6384)", () => {
  it("links to /creators-2026 without a UTM tag", () => {
    // Landing reads window.location.search at render. The suite runs in the node
    // environment (no DOM), so provide the minimal shape it touches.
    const g = globalThis as any;
    const prevWindow = g.window;
    g.window = prevWindow ?? { location: { search: "" } };
    try {
      const html = renderToString(
        React.createElement(
          AuthProvider,
          null,
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/"] },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, { path: "/", element: React.createElement(Landing) })
            )
          )
        )
      );
      expect(html).toContain('href="/creators-2026"');
      // the entry link must not pre-attribute the visit; the explainer's own CTAs do that
      expect(html).not.toMatch(/href="\/creators-2026\?[^"]*utm_/);
    } finally {
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
    }
  });
});
