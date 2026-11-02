import { describe, expect, it } from "vitest";
import { dataUrlToBase64 } from "./blobToBase64";

// ADAAAA-7724: a MediaRecorder that records video + audio reports a MIME with a
// comma in it (`video/webm;codecs=vp9,opus`), so the data URL is
// `data:video/webm;codecs=vp9,opus;base64,<payload>`. Splitting on the first
// comma extracted `opus;base64,...` instead of the payload, the server decoded a
// handful of junk bytes, and the session recording was corrupt -> every browser
// highlight got an empty clipUri.
describe("dataUrlToBase64 (ADAAAA-7724)", () => {
  it("extracts the payload from a comma-bearing MIME (vp9,opus)", () => {
    const bytes = Buffer.from("a real webm chunk", "utf8");
    const url = `data:video/webm;codecs=vp9,opus;base64,${bytes.toString("base64")}`;
    const got = Buffer.from(dataUrlToBase64(url), "base64");
    expect(got.equals(bytes)).toBe(true);
  });

  it("extracts the payload from a plain MIME", () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]);
    const url = `data:video/webm;codecs=vp8;base64,${bytes.toString("base64")}`;
    expect(Buffer.from(dataUrlToBase64(url), "base64").equals(bytes)).toBe(true);
  });

  it("never returns the MIME tail for a comma-bearing MIME (the old bug)", () => {
    const url = "data:video/webm;codecs=vp9,opus;base64,QUJD";
    const got = dataUrlToBase64(url);
    expect(got).toBe("QUJD");
    expect(got.startsWith("opus")).toBe(false);
  });

  it("falls back to the first comma when there is no base64 marker", () => {
    expect(dataUrlToBase64("data:text/plain,hello")).toBe("hello");
    expect(dataUrlToBase64("")).toBe("");
  });
});
