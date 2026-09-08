import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers";

async function register(app: any, email: string, pw = "password123") {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  return r.json().token;
}

describe("dev wireframe billing (BILLING_WIREFRAME=1)", () => {
  it("404s when wireframe is disabled", async () => {
    const { app } = await buildTestApp(); // no BILLING_WIREFRAME
    const token = await register(app, "w0@x.dev");
    const r = await app.inject({ method: "POST", url: "/dev/billing/activate", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("checkout returns a local wireframe URL; activate pro lifts the free-cap 402; deactivate restores it", async () => {
    const { app } = await buildTestApp({ BILLING_WIREFRAME: "1", FREE_HIGHLIGHTS: "2" });
    const token = await register(app, "w1@x.dev");

    // wireframe checkout URL points back at the app
    const co = await app.inject({ method: "POST", url: "/billing/checkout", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(co.statusCode).toBe(200);
    expect(co.json().url).toContain("wireframe=checkout=success");

    // exhaust the free cap -> 402
    await app.inject({ method: "POST", url: "/dev/billing/reset-usage", headers: { authorization: `Bearer ${token}` }, payload: {} });
    const st = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    expect(st.json().tier).toBe("free");

    // activate pro (wireframe webhook)
    const act = await app.inject({ method: "POST", url: "/dev/billing/activate", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(act.statusCode).toBe(200);
    expect(act.json().sub.tier).toBe("pro");
    expect(act.json().sub.stripeSubItemId).toBe("si_wire_metered");

    const after = await app.inject({ method: "GET", url: "/billing/status", headers: { authorization: `Bearer ${token}` } });
    expect(after.json().tier).toBe("pro");
    expect(after.json().status).toBe("active");

    // deactivate -> free/canceled
    const deact = await app.inject({ method: "POST", url: "/dev/billing/deactivate", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(deact.statusCode).toBe(200);
    expect(deact.json().sub.tier).toBe("free");

    // portal also returns a local wireframe URL even while "free"
    const po = await app.inject({ method: "POST", url: "/billing/portal", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(po.json().url).toContain("wireframe=portal");

    await app.close();
  });
});
