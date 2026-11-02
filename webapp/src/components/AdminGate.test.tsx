import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import React from "react";
import { AdminGate } from "./AdminGate";
import { isAdminRole } from "../lib/auth";

// ADAAAA-7727 (Inc 1 of ADAAAA-7726): AC3 requires /app/admin to be
// admin-only — a `role=user` session navigating there must never see the
// operator surface, and an admin must. The gate is a route element so the
// directory cannot be reached by URL alone (nav hiding is not the guard).

function visit(role: string | null): string {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/app/admin"] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: "/app/admin",
          element: React.createElement(AdminGate, {
            role,
            children: React.createElement("div", null, "OPERATOR-SECRET"),
          }),
        }),
        React.createElement(Route, {
          path: "/app",
          element: React.createElement("div", null, "app-home"),
        })
      )
    )
  );
}

describe("AdminGate", () => {
  it("only the exact admin role is admin", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("user")).toBe(false);
    expect(isAdminRole("admin_readonly")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });

  it("does not render the admin surface for role=user", () => {
    const html = visit("user");
    expect(html).not.toContain("OPERATOR-SECRET");
    expect(html).not.toContain("app-home"); // redirect target, not the current route
  });

  it("does not render the admin surface for an unauthenticated session", () => {
    expect(visit(null)).not.toContain("OPERATOR-SECRET");
  });

  it("renders the admin surface for role=admin", () => {
    const html = visit("admin");
    expect(html).toContain("OPERATOR-SECRET");
  });
});
