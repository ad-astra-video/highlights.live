import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VOD_COST_ALARM_USD_PER_VIDEO_HOUR,
  VOD_COST_CEILING_USD_PER_VIDEO_HOUR,
  VOD_MEASURED_COGS_USD_PER_VIDEO_HOUR,
  VOD_MONTHLY_CAP_USD,
  VOD_PRICING_RULING,
  VOD_RETAIL_DEPTHS,
  VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR,
  VOD_RETIRED_RETAIL_PRICE_USD_PER_VIDEO_HOUR,
  vodRetailPriceUsdPerVideoHour,
} from "../src/vod-pricing";

// ADAAAA-9175: the board-ratified VOD price ladder is $12.00/video-hour at
// standard depth and $16.00/video-hour at max depth (ADAAAA-9143 `ruling` rev
// 2, option A). The $3.00/$4.00 ladder is retired because it was derived from a
// modelled $0.40/$0.83 COGS that assumed ~121 decides/vh where the served 3 s
// observe loop makes ~1,200 — a 9.9x cadence gap. This guard is the regression
// pin: the ratified numbers cannot drift and the retired ladder cannot come
// back as a VOD retail price anywhere a price reader or a customer path reads.

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Directories whose text can carry a VOD retail price a reader/customer sees. */
const PRICE_SURFACE_DIRS = [
  "services/server/src",
  "webapp/src",
  "docs",
  ...readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && statSync(join(REPO_ROOT, "packages", d.name, "src"), { throwIfNoEntry: false }))
    .map((d) => join("packages", d.name, "src")),
];

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".css", ".md", ".json"]);

/** A line that talks about price / video-hour units. */
const PRICE_SIGNAL = /retail|price|pricing|\/vh\b|per video[- ]hour|video[- ]hour|\/\s*h\b/i;
/** The retired ladder as a dollar amount: `$3.00`, `$4.00`, `3.00/video-hour`. */
const RETIRED_AMOUNT = /\$\s?[34]\.00\b|\b[34]\.00\s*(?:\/|per)\s*(?:video[- ]hour|vh|h)\b/i;
/** The retired ladder as a bare numeric price field: `vodPrice: 3`, `retailPriceUsdPerVh = 4.00`. */
const RETIRED_NUMBER_FIELD = /\b[A-Za-z_]*(?:price|Price|PRICE)[A-Za-z_]*\s*[:=]\s*[34](?:\.0+)?\b/;
/** A line may NAME the retired ladder only while saying it is retired. */
const RETIRED_LABEL = /retire/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      walk(full, out);
    } else if (SCANNED_EXTENSIONS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function offendingLines(): string[] {
  const hits: string[] = [];
  for (const rel of PRICE_SURFACE_DIRS) {
    for (const file of walk(join(REPO_ROOT, rel))) {
      if (file.startsWith(TEST_DIR)) continue; // this guard names the retired ladder on purpose
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!PRICE_SIGNAL.test(line)) return;
        if (!RETIRED_AMOUNT.test(line) && !RETIRED_NUMBER_FIELD.test(line)) return;
        if (RETIRED_LABEL.test(line)) return;
        hits.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return hits;
}

describe("ratified VOD retail ladder", () => {
  it("pins $12.00/video-hour standard and $16.00/video-hour max", () => {
    expect(VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR).toEqual({ standard: 12.0, max: 16.0 });
    expect(vodRetailPriceUsdPerVideoHour("standard")).toBe(12.0);
    expect(vodRetailPriceUsdPerVideoHour("max")).toBe(16.0);
  });

  it("carries exactly the two priced depths, with no depth silently unpriced", () => {
    expect([...VOD_RETAIL_DEPTHS]).toEqual(["standard", "max"]);
    for (const depth of VOD_RETAIL_DEPTHS) {
      expect(Number.isFinite(vodRetailPriceUsdPerVideoHour(depth))).toBe(true);
      expect(vodRetailPriceUsdPerVideoHour(depth)).toBeGreaterThan(0);
    }
  });

  it("refuses an unknown depth instead of falling back to a stale price", () => {
    expect(() => vodRetailPriceUsdPerVideoHour("ultra" as never)).toThrow(/no ratified VOD retail price/);
  });

  it("is frozen, so a price is a board term and not a runtime knob", () => {
    expect(Object.isFrozen(VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR)).toBe(true);
    expect(() => {
      (VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR as { standard: number }).standard = 3.0;
    }).toThrow();
    expect(VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR.standard).toBe(12.0);
  });

  it("keeps the retired ladder out of the price of record", () => {
    expect(VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR.standard).not.toBe(
      VOD_RETIRED_RETAIL_PRICE_USD_PER_VIDEO_HOUR.standard,
    );
    expect(VOD_RETAIL_PRICE_USD_PER_VIDEO_HOUR.max).not.toBe(VOD_RETIRED_RETAIL_PRICE_USD_PER_VIDEO_HOUR.max);
    // Named only so a legacy quote can be labelled; never a price reader's value.
    expect(VOD_RETIRED_RETAIL_PRICE_USD_PER_VIDEO_HOUR).toEqual({ standard: 3.0, max: 4.0 });
  });

  it("holds the cost envelope the prices are set against", () => {
    expect(VOD_COST_CEILING_USD_PER_VIDEO_HOUR).toBe(5.0);
    expect(VOD_COST_ALARM_USD_PER_VIDEO_HOUR).toBe(7.5);
    expect(VOD_COST_ALARM_USD_PER_VIDEO_HOUR).toBe(VOD_COST_CEILING_USD_PER_VIDEO_HOUR * 1.5);
    expect(VOD_MONTHLY_CAP_USD).toBe(50.0);
    expect(VOD_MEASURED_COGS_USD_PER_VIDEO_HOUR).toEqual({
      lt120s: 4.06,
      s120to200: 4.63,
      s200to400: 4.31,
      gte400s: 4.69,
    });
  });

  it("cites the ruling of record rather than a re-derivation", () => {
    expect(VOD_PRICING_RULING.issue).toBe("ADAAAA-9143");
    expect(VOD_PRICING_RULING.documentKey).toBe("ruling");
    expect(VOD_PRICING_RULING.revision).toBe(2);
    expect(VOD_PRICING_RULING.option).toBe("A");
    expect(VOD_PRICING_RULING.implementedBy).toBe("ADAAAA-9175");
  });
});

describe("retired ladder guard", () => {
  it("fails when $3.00/$4.00 reappears as a VOD retail price", () => {
    const hits = offendingLines();
    expect(hits).toEqual([]);
  });

  it("detects a reintroduced ladder (guard self-test)", () => {
    // The rule the scan uses, exercised on the exact shapes that must fail: a
    // price reader quoting the retired points, and the header sentence the
    // meter carried before ADAAAA-9175.
    const reintroduced = [
      'export const VOD_PRICE_PER_VIDEO_HOUR = { standard: "$3.00/video-hour", max: "$4.00/video-hour" };',
      "// The ratified price points ($3.00/video-hour standard depth, $4.00 at max depth)",
      '  retailPriceUsdPerVideoHour: 4.00, // price per video-hour, max depth',
    ];
    const allowed = [
      "// RETIRED: the $3.00 standard / $4.00 max ladder is not the price of record.",
      "// measured COGS $4.06-4.69 per video-hour at the $5.00/vh ceiling",
    ];
    const flags = (line: string) =>
      PRICE_SIGNAL.test(line) &&
      (RETIRED_AMOUNT.test(line) || RETIRED_NUMBER_FIELD.test(line)) &&
      !RETIRED_LABEL.test(line);
    expect(reintroduced.filter(flags)).toEqual(reintroduced);
    expect(allowed.filter(flags)).toEqual([]);
  });
});

describe("vod-meter derivation header", () => {
  const header = readFileSync(join(TEST_DIR, "../src/vod-meter.ts"), "utf8");

  it("states the measured COGS bands, not the retired model", () => {
    for (const band of ["4.06", "4.63", "4.31", "4.69"]) expect(header).toContain(band);
    expect(header).toMatch(/flat\s*\n?.*8\.4x|8\.4x source-duration span/s);
  });

  it("carries the ceiling, the alarm, the cap and the ruling citation", () => {
    expect(header).toContain("$5.00 per video-hour");
    expect(header).toContain("trailing-14-day mean");
    expect(header).toContain("$7.50 per video-hour");
    expect(header).toContain("$50.00/month");
    expect(header).toContain("ADAAAA-9143");
    expect(header).toContain("rev 2");
  });

  it("labels the $0.40/$0.83 model retired with the 9.9x cadence gap as the cause", () => {
    expect(header).toContain("$0.40");
    expect(header).toContain("$0.83");
    expect(header).toContain("9.9x");
    expect(header).toMatch(/RETIRED[\s\S]*\$0\.40 \/ \$0\.83/);
    expect(header).toMatch(/1,200 decides\/vh/);
  });

  it("names the ratified ladder it now reads against", () => {
    expect(header).toContain("$12.00 per video-hour");
    expect(header).toContain("$16.00 per video-hour");
    expect(header).toContain("vod-pricing.ts");
  });
});
