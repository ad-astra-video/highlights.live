import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect } from "vitest";
import React from "react";
import { AuthProvider } from "../lib/auth";
import { Shell } from "./Shell";

/**
 * ADAAAA-7886: the app shell has to stay usable on a phone. These assertions
 * guard the three structural decisions the responsive fix depends on, so a
 * later "cleanup" cannot silently put the 240 px sidebar back inline below
 * `md`, drop the labelled drawer toggle, or move `main`'s padding (JobDetail's
 * sticky analysis bar compensates `p-8` with `-top-8`/`-mx-8 px-8`).
 */
function renderShell() {
  return renderToString(
    React.createElement(
      AuthProvider,
      null,
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/app/jobs/abc12345"] },
        React.createElement(
          Routes,
          null,
          React.createElement(
            Route,
            { path: "/app", element: React.createElement(Shell) },
            React.createElement(Route, { path: "jobs/:id", element: React.createElement("div", null, "job") })
          )
        )
      )
    )
  );
}

describe("responsive app shell (ADAAAA-7886)", () => {
  const html = renderShell();

  it("renders a labelled drawer toggle that is hidden at md and above", () => {
    expect(html).toContain('data-shell-nav-toggle="true"');
    expect(html).toContain('aria-label="Open navigation"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="shell-nav"');
    // the top bar (and therefore the toggle) exists only below `md`
    expect(html).toMatch(/class="[^"]*md:hidden[^"]*"[^>]*data-shell-topbar/);
  });

  it("keeps the sidebar inline only from md upwards", () => {
    expect(html).toContain('data-shell-sidebar="true"');
    expect(html).toMatch(/class="hidden w-60 shrink-0 flex-col[^"]*md:flex"/);
  });

  it("renders no drawer until the toggle is used", () => {
    expect(html).not.toContain("data-shell-drawer");
    expect(html).not.toContain('role="dialog"');
  });

  it("keeps main's p-8 scrollport that the sticky analysis bar compensates", () => {
    expect(html).toMatch(/<main class="min-w-0 flex-1 overflow-y-auto p-8">/);
  });

  it("still renders every nav entry", () => {
    for (const label of ["Highlights", "Fine Tune", "Billing", "Settings"]) {
      expect(html).toContain(label);
    }
  });
});
