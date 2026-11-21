// ADAAAA-8099 — QA evidence must outlive a container recreate.
//
// Two halves, both $0:
//  1. `services/server/src/log-file.ts` tees stdout/stderr to
//     `${DATA_DIR}/logs/server.log` and rotates it in place, so the lane lines
//     ADAAAA-9184 grades are still on disk after a recreate and the file cannot
//     creep past its cap. A restart (the recreate analogue) APPENDS: the lines
//     written by the previous container must still be readable.
//  2. `docker/docker-compose.yml` (and the gpu override) carry a bounded
//     json-file `logging:` block for the `server` service, and the server keeps
//     the `./data:/data` bind mount the durable file lives under.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_LOG_MAX_BYTES,
  SERVER_LOG_MAX_FILES,
  installLogFileTee,
  serverLogFilePath,
} from "../src/log-file.js";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hl-log-8099-"));
}

/** A stand-in for process.stdout that keeps what the serving path wrote. */
function sink() {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: unknown) {
      chunks.push(String(chunk));
      return true;
    },
  };
}

describe("server log file survives a recreate (ADAAAA-8099)", () => {
  it("writes the compose DATA_DIR path and appends across a restart", () => {
    expect(serverLogFilePath({} as NodeJS.ProcessEnv)).toBe(join("data", "logs", "server.log"));
    expect(serverLogFilePath({ DATA_DIR: "/data" } as NodeJS.ProcessEnv)).toBe("/data/logs/server.log");

    const dir = tempDir();
    try {
      const file = join(dir, "logs", "server.log");
      // Container #1 writes the lines a QA leg needs, then dies (recreate).
      const out1 = sink();
      const boot1 = installLogFileTee({ file, out: out1, err: sink() });
      out1.write("[ingest-gap:job1] decide @12.00s decideE2eMs=900\n");
      out1.write("[browser:job1] live clip 1.mp4 ready mid-share idx=2\n");
      boot1.close();

      // Container #2 boots on the SAME host bind mount: the old lines are there.
      const out2 = sink();
      const boot2 = installLogFileTee({ file, out: out2, err: sink() });
      out2.write("[summary:job1] stored confidence=0.82 avoid={}\n");
      boot2.close();

      const text = readFileSync(file, "utf8");
      expect(text).toContain("[ingest-gap:job1] decide @12.00s decideE2eMs=900");
      expect(text).toContain("ready mid-share idx=2");
      expect(text).toContain("[summary:job1] stored confidence=0.82 avoid={}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tees stdout AND stderr without disturbing the original sinks", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "server.log");
      const out = sink();
      const err = sink();
      const tee = installLogFileTee({ file, out, err });
      out.write("to-stdout\n");
      err.write("to-stderr\n");
      tee.close();

      // The serving path still receives exactly what it wrote, in order...
      expect(out.chunks).toEqual(["to-stdout\n"]);
      expect(err.chunks).toEqual(["to-stderr\n"]);
      // ...and the durable file is the union.
      const text = readFileSync(file, "utf8");
      expect(text).toContain("to-stdout");
      expect(text).toContain("to-stderr");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds retention: cap per file, fixed number of rotated segments", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "server.log");
      const line = "x".repeat(99) + "\n"; // 100 bytes
      const tee = installLogFileTee({ file, maxBytes: 1000, maxFiles: 2, out: sink(), err: sink() });
      const out = sink();
      tee.close();
      const boot = installLogFileTee({ file, maxBytes: 1000, maxFiles: 2, out, err: sink() });
      for (let i = 0; i < 100; i++) out.write(`line-${i}: ${line}`);
      boot.close();

      // server.log + .1 + .2, never more.
      expect(readdirSync(dir).sort()).toEqual(["server.log", "server.log.1", "server.log.2"]);
      for (const name of readdirSync(dir)) {
        expect(statSync(join(dir, name)).size, `${name} must stay <= the cap`).toBeLessThanOrEqual(1000);
      }
      // Total retention is bounded by (maxFiles + 1) * maxBytes.
      const total = readdirSync(dir).reduce((sum, n) => sum + statSync(join(dir, n)).size, 0);
      expect(total).toBeLessThanOrEqual(3 * 1000);
      // The newest line is in server.log; rotation never splits a line.
      const current = readFileSync(file, "utf8");
      expect(current).toContain("line-99:");
      for (const name of readdirSync(dir)) {
        const text = readFileSync(join(dir, name), "utf8");
        for (const row of text.split("\n").filter(Boolean)) {
          expect(row.startsWith("line-"), `${name} carries a torn line`).toBe(true);
          expect(row.endsWith("x".repeat(99))).toBe(true);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts pre-existing bytes so a restart cannot exceed the cap", () => {
    const dir = tempDir();
    try {
      const file = join(dir, "server.log");
      writeFileSync(file, "y".repeat(990));
      const tee = installLogFileTee({ file, maxBytes: 1000, maxFiles: 2, out: sink(), err: sink() });
      const out = sink();
      tee.close();
      const boot = installLogFileTee({ file, maxBytes: 1000, maxFiles: 2, out, err: sink() });
      out.write("z".repeat(50));
      boot.close();
      expect(boot.rotations).toBe(1);
      expect(statSync(file).size).toBe(50);
      expect(readFileSync(join(dir, "server.log.1"), "utf8")).toBe("y".repeat(990));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws into the serving path when the log path is unwritable", () => {
    const dir = tempDir();
    try {
      // Put a regular file where the log DIRECTORY should be: mkdir fails, and
      // the server must still boot and serve with stdout only.
      const blocked = join(dir, "logs");
      writeFileSync(blocked, "not a directory");
      const file = join(blocked, "server.log");
      const out = sink();
      const tee = installLogFileTee({ file, out, err: sink() });
      expect(tee.writeErrors).toBeGreaterThan(0);
      out.write("still-served\n");
      expect(out.chunks).toEqual(["still-served\n"]);
      tee.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compose wiring for durable server logs (ADAAAA-8099)", () => {
  const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");
  const gpuOverlay = readFileSync(repoFile("docker/docker-compose.gpu.yml"), "utf8");

  /** The text of one top-level service block (ends at the next 2-space key). */
  function serviceBlock(source: string, name: string): string {
    const start = source.indexOf(`\n  ${name}:\n`);
    expect(start, `${name} service must exist`).toBeGreaterThanOrEqual(0);
    const rest = source.slice(start + `\n  ${name}:\n`.length);
    const end = rest.search(/\n  [a-z0-9-]+:\n/);
    return end === -1 ? rest : rest.slice(0, end);
  }

  const boundedLogging = (block: string): boolean => {
    return (
      /logging:\s*\n\s+driver: json-file\s*\n\s+options:\s*\n\s+max-size: "(\d+)m"\s*\n\s+max-file: "(\d+)"/.test(block) &&
      block.includes('max-size: "25m"') &&
      block.includes('max-file: "4"')
    );
  };

  it("greps the base server service: bounded json-file rotation", () => {
    const server = serviceBlock(compose, "server");
    expect(server).toContain("container_name: highlights-server");
    expect(boundedLogging(server), "server needs a bounded json-file logging block").toBe(true);
    // The durable file lives under the server's dataDir bind mount.
    expect(server).toContain("./data:/data");
    expect(server).toContain("DATA_DIR=/data");
  });

  it("keeps the gpu override identical so an overlay deploy cannot loosen it", () => {
    const base = serviceBlock(compose, "server");
    const gpu = serviceBlock(gpuOverlay, "server");
    expect(boundedLogging(gpu), "gpu override server needs the same logging block").toBe(true);
    const opt = (block: string) => block.match(/logging:\s*\n\s+driver: json-file\s*\n\s+options:\s*\n\s+max-size: "[^"]+"\s*\n\s+max-file: "[^"]+"/)?.[0];
    expect(opt(gpu)).toBe(opt(base));
  });

  it("matches the in-process rotation constants to the compose cap", () => {
    // Two independent budgets: docker's json-file log (compose) and the durable
    // file (code). Both must be bounded; the code cap must be a real number.
    expect(SERVER_LOG_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(SERVER_LOG_MAX_FILES).toBe(4);
    expect(compose).toContain('max-size: "25m"');
  });
});
