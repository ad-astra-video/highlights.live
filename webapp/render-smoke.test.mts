import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, it, expect } from "vitest";
import React from "react";
import { Dataset } from "./src/pages/Dataset";
import { Train } from "./src/pages/Train";

function renderPage(El: React.ComponentType) {
  return renderToString(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/app/dataset"] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, { path: "/app/dataset", element: React.createElement(El) })
      )
    )
  );
}

describe("fine-tune help sidebar + walkthrough (ADAAAA-5327)", () => {
  for (const [name, El] of [
    ["Dataset", Dataset],
    ["Train", Train],
  ] as const) {
    it(`${name} renders the help sidebar + walkthrough without errors`, () => {
      const html = renderPage(El);
      expect(html.length).toBeGreaterThan(100);
      expect(html).toContain("Fine-tune help");
      expect(html).toContain("The fast path — 6 steps");
      expect(html).toContain("Why tune?");
      // examples render readably
      expect(html).toContain("What a good box looks like");
      expect(html).toContain("Example manifest");
      expect(html).toContain("Epochs guidance");
      // closed 5-label soccer vocab
      for (const l of ["player", "soccer ball", "goalkeeper", "goal", "referee"]) {
        expect(html).toContain(l);
      }
      // no feature claims that don't exist
      expect(html).not.toContain("[LINK]");
    });
  }
});
