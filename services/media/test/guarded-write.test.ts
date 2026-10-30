// Regression coverage for the guarded-write helpers (ADAAAA-7591).
//
// The live media container died twice on 2026-10-30 with an unhandled 'error':
//   Error: write EPIPE at WriteWrap.onWriteComplete
//   Emitted 'error' event on Socket instance at: ... emitErrorNT
// i.e. a write into a peer that had already closed. With no 'error' listener on
// the socket/stream node re-throws the event and the process exits (compose
// `restart: no` -> ingest stays down). These tests destroy a real peer mid-write
// and require the failure to be logged + cleaned up without an uncaught error.
import { describe, expect, it, vi } from "vitest";
import net from "node:net";
import { PassThrough } from "node:stream";
import { guardStream, safeEnd, safeWrite, canWrite } from "../src/guarded-write";

describe("guarded writes: a destroyed peer never becomes an unhandled 'error' (ADAAAA-7591)", () => {
  const withUncaughtSpy = async (fn: (uncaught: Error[]) => Promise<void>) => {
    const uncaught: Error[] = [];
    const onUncaught = (e: Error) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      await fn(uncaught);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  };

  it("logs a warn naming the session and closes a TCP socket whose peer was reset mid-write", async () => {
    await withUncaughtSpy(async (uncaught) => {
      // Accept, then abort the connection with RST while the client's write is
      // still queued — the live shape (a browser socket that vanished mid-frame).
      const server = net.createServer((sock) => {
        sock.on("error", () => {});
        setTimeout(() => {
          try {
            sock.resetAndDestroy();
          } catch {
            /* already gone */
          }
        }, 60);
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as net.AddressInfo).port;
      const client = net.connect(port, "127.0.0.1");
      client.on("error", () => {}); // the client's own side is not under test
      await new Promise<void>((r) => client.on("ready", () => r()));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const labels: string[] = [];
      let ok = false;
      let logged: string[] = [];
      try {
        guardStream(client, "ws session=sess-tcp");
        // Larger than the socket buffer, so part of the write is still in flight
        // when the peer is reset.
        ok = safeWrite(client, Buffer.alloc(4 * 1024 * 1024, 1), "ws session=sess-tcp", () => labels.push("cleanup"));
        await new Promise((r) => setTimeout(r, 400)); // let the EPIPE land
        logged = warn.mock.calls.map((c) => String(c[0]));
      } finally {
        warn.mockRestore(); // mockRestore clears recorded calls, so read them first
      }
      expect(ok).toBe(true);
      // No uncaught 'error' event reached the process...
      expect(uncaught).toEqual([]);
      // ...the failure was logged at warn with the session id...
      expect(logged.some((s) => s.includes("write-failed") && s.includes("session=sess-tcp"))).toBe(true);
      // ...the dead socket was destroyed (cleanup path ran)...
      expect(client.destroyed).toBe(true);
      expect(labels).toContain("cleanup");
      // ...and further writes are skipped instead of manufacturing new errors.
      expect(safeWrite(client, Buffer.from("late"), "ws session=sess-tcp")).toBe(false);
      expect(canWrite(client)).toBe(false);
      server.close();
    });
  });

  it("skips writes/end on an already-destroyed stream", async () => {
    await withUncaughtSpy(async (uncaught) => {
      const s = new PassThrough();
      guardStream(s, "recording session=sess-destroyed");
      s.destroy();
      await new Promise((r) => setTimeout(r, 20));
      expect(safeWrite(s, Buffer.from("x"), "recording session=sess-destroyed")).toBe(false);
      expect(safeEnd(s, "recording session=sess-destroyed")).toBe(false);
      expect(uncaught).toEqual([]);
    });
  });

  it("is idempotent: one guard listener per stream, still logging under its label", async () => {
    const s = new PassThrough();
    const seen: string[] = [];
    guardStream(s, "recording session=one");
    guardStream(s, "recording session=one");
    guardStream(s, "recording session=ignored");
    expect(s.listenerCount("error")).toBe(1); // repeated attach did not stack listeners
    const warn = vi.spyOn(console, "warn").mockImplementation((m: any) => seen.push(String(m)));
    try {
      s.on("error", () => {});
      s.destroy(new Error("boom"));
      await new Promise((r) => setTimeout(r, 50)); // 'error' is emitted on nextTick
    } finally {
      warn.mockRestore();
    }
    expect(seen.some((l) => l.includes("write-failed") && l.includes("session=one"))).toBe(true);
    expect(seen.some((l) => l.includes("session=ignored"))).toBe(false);
  });
});
