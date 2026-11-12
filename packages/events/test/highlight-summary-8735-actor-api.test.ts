// ADAAAA-8735 (spec ADAAAA-8665 rev 4): the actor-attestation API that AC9's
// action fact now reads. These helpers are new in rev 4, so this file is the
// ADDITIVE-API pin (it cannot run on the rev-3 build, by construction); the
// falsifier for the served defect is `highlight-summary-8735.test.ts`, which
// imports only rev-3 exports.
import { describe, expect, it } from "vitest";
import {
  attestedActorNames,
  bodyNamesAttestedActor,
  bodyNamesEntity,
  matchContextEntityNames,
  type SummaryEvidence,
} from "../src/highlight-summary.js";

const evidence = (extra: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Ball shoots on the left.",
  caption: "Ball shoots on the left.",
  postTitle: null,
  windowTs: 173,
  windowDurationS: 8,
  scoreTransition: null,
  matchContext: null,
  transcript: null,
  ...extra,
});

describe("matchContextEntityNames", () => {
  it("reads teams and players from the structured fields, in every stored shape", () => {
    expect(matchContextEntityNames({ teams: [{ name: "Northbridge" }, { name: "Riverside" }] })).toEqual([
      "Northbridge",
      "Riverside",
    ]);
    expect(matchContextEntityNames({ teams: ["Northbridge", "Riverside"] })).toEqual(["Northbridge", "Riverside"]);
    expect(matchContextEntityNames({ sides: [{ team: "Northbridge" }, { label: "Riverside" }] })).toEqual([
      "Northbridge",
      "Riverside",
    ]);
    expect(matchContextEntityNames({ players: [{ name: "J. Smith", position: "Midfielder" }] })).toEqual(["J. Smith"]);
    expect(matchContextEntityNames({ roster: ["Virgil van Dijk"] })).toEqual(["Virgil van Dijk"]);
  });

  it("never invents a name from a missing or malformed context", () => {
    expect(matchContextEntityNames(null)).toEqual([]);
    expect(matchContextEntityNames(undefined)).toEqual([]);
    expect(matchContextEntityNames("Soccer")).toEqual([]);
    expect(matchContextEntityNames({ teams: [{ confidence: 0.4 }], gameHint: "Soccer" })).toEqual([]);
  });
});

describe("attestedActorNames", () => {
  it("is empty on the live rail's real evidence (no matchContext, no transcript)", () => {
    // The measured rev-3 shape: reason `Ball shoots on the left.` and nothing
    // else. Action must not be available.
    expect(attestedActorNames(evidence())).toEqual([]);
  });

  it("does not take the decide reason as a name source", () => {
    expect(attestedActorNames(evidence({ reason: "Barcelona shoots on the left." }))).toEqual([]);
  });

  it("takes matchContext teams/players and transcript names", () => {
    expect(
      attestedActorNames(
        evidence({ matchContext: { teams: [{ name: "Northbridge" }] }, transcript: "Barcelona push forward" })
      ).sort()
    ).toEqual(["Barcelona", "Northbridge"]);
  });

  it("does not take the ASR sentence-initial common noun as a name", () => {
    expect(attestedActorNames(evidence({ transcript: "Ball shoots on the left." }))).toEqual([]);
  });
});

describe("bodyNamesEntity / bodyNamesAttestedActor", () => {
  it("matches the whole phrase, case- and punctuation-insensitively", () => {
    expect(bodyNamesEntity("At 3:23, northbridge shoot on the right.", ["Northbridge"])).toBe(true);
    expect(bodyNamesEntity("At 3:23, NORTHBRIDGE shoot on the right.", ["Northbridge"])).toBe(true);
    expect(bodyNamesEntity("At 3:23, the ball shoots on the right.", ["Northbridge"])).toBe(false);
  });

  it("matches a distinctive token of a multi-token roster name", () => {
    expect(bodyNamesEntity("Virgil van Dijk heads it clear at 3:23.", ["Virgil van Dijk"])).toBe(true);
    expect(bodyNamesEntity("Van Dijk heads it clear at 3:23.", ["Virgil van Dijk"])).toBe(true);
  });

  it("is false when the row attests no actor at all", () => {
    const body = "At 3:23, the ball shoots on the right side of the field.";
    expect(bodyNamesAttestedActor(body, evidence())).toBe(false);
    expect(bodyNamesAttestedActor(body, evidence({ matchContext: { teams: ["Northbridge"] } }))).toBe(false);
    expect(bodyNamesAttestedActor("Northbridge shoot at 3:23.", evidence({ matchContext: { teams: ["Northbridge"] } }))).toBe(
      true
    );
  });
});
