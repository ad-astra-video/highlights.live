// ADAAAA-8405 (PO ship bar S4): the ANNOUNCER detail a surface serves.
//
// S4 is "100% of postable cards carry a non-degrade announcer caption — stored
// `caption` non-empty and NOT byte-identical to `postTitle`". The write seam now
// stores `caption := card.caption || storedReason` (commit 0f4f3ed), so a row
// written after that change always has detail copy. Rows written BEFORE it store
// `reason` and no `caption`, and the detail route degraded to the post title:
// measured on the 20 stored rows, 3/10 postable cards carried a non-degrade
// caption and the six legacy scoring rows all served `caption == postTitle`.
//
// `projectAnnouncerCaption` mirrors the seam at read time: the row's own GATED
// `reason` is served when `caption` is absent. Nothing is invented (the sentence
// is one the write seam already certified and already serves as `reason`), the
// audit-only `reasonRaw` is NEVER used (it did not cross the claim/name gates),
// and a caption that would be byte-identical to the title is refused so the
// degrade cannot come back through this path.
import { describe, expect, it } from "vitest";
import {
  deterministicPostTitle,
  projectAnnouncerCaption,
  projectPostTitle,
  type PostTitleRow,
} from "../src/post-title";

const row = (over: Partial<PostTitleRow>): PostTitleRow => ({
  eventType: "GOAL",
  outcome: "scoring_play",
  localizedTs: 158,
  ...over,
});

const titleOf = (r: PostTitleRow) => projectPostTitle(r, { subject: "" });

describe("ADAAAA-8405 S4 — a legacy row serves its own gated sentence, not the title", () => {
  it("serves `reason` when the row stores no caption", () => {
    // The measured legacy class: scoring_play row, caption null, reason is the
    // gated announcer line, title is the model headline.
    const r = row({
      postTitle: "David Saez scores",
      caption: null,
      reason: "Ball shoots on the left.",
      reasonRaw: "Scoreboard changes to 2-2 at t=-3.3s and ball enters net.",
    });
    const title = titleOf(r);
    expect(projectAnnouncerCaption(r, title)).toBe("Ball shoots on the left.");
    expect(projectAnnouncerCaption(r, title)).not.toBe(title);
  });

  it("serves a stored caption byte-for-byte when it is present", () => {
    const r = row({ postTitle: "David Saez scores", caption: "Ball shoots on the left." });
    expect(projectAnnouncerCaption(r, titleOf(r))).toBe("Ball shoots on the left.");
  });

  it("never lets the degrade back in: a `reason` equal to the title is not detail", () => {
    const r = row({ postTitle: "No. 7 scores", caption: null, reason: "No. 7 scores" });
    const title = titleOf(r);
    // ADAAAA-8411 (Phase D AC4 FAIL): the degrade is now unreachable for a row
    // that carries an instant — a `reason` that repeats the headline is not
    // detail, so the row serves its own FACT sentence (its stored verdict + its
    // own window instant) instead of the title.
    expect(projectAnnouncerCaption(r, title)).toBe("Goal at 2:38.");
    expect(projectAnnouncerCaption(r, title)).not.toBe(title);
  });

  it("never serves the un-gated audit line verbatim — it derives the row's own fact sentence", () => {
    // Measured row f4407757 (Phase D FAIL, ADAAAA-8411): the seam refused the
    // sentence as written (`at t=` is evidence provenance), so the row carries
    // ONLY `reasonRaw`. Serving it byte-for-byte would publish copy the claim
    // gate refused; dropping the attestation clause and the window marker leaves
    // the row's own ledger frame, which the gates DO accept. Measured 3/3
    // postable cards non-degrade after this change (2/3 before).
    const r = row({
      postTitle: "David Saez scores",
      caption: null,
      reason: null,
      reasonRaw: "Scoreboard changes to 2-2 at t=-3.3s and ASR confirms goal.",
    });
    const title = titleOf(r);
    const caption = projectAnnouncerCaption(r, title);
    expect(caption).toBe("Scoreboard changes to 2-2.");
    expect(caption).not.toBe(title);
    expect(caption).not.toMatch(/t=|ASR|confirms/);
  });

  it("pairs with the read gate: an S3-refused title serves the label AND keeps its detail", () => {
    // The served pair a card actually renders: the title falls back to
    // `GOAL · m:ss` (S3: `David Saez` is not in this row's copy) while the
    // announcer detail still comes from the row's own sentence.
    const r = row({
      postTitle: "David Saez scores",
      caption: null,
      reason: "Ball shoots in midfield.",
      reasonRaw: "Scoreboard changes from 2-1 to 2-2 at t=-1.3s.",
    });
    const title = titleOf(r);
    expect(title).toBe(
      deterministicPostTitle({ eventType: "GOAL", outcome: "scoring_play", windowTs: 158 })
    );
    const caption = projectAnnouncerCaption(r, title);
    expect(caption).toBe("Ball shoots in midfield.");
    expect(caption).not.toBe(title);
  });
});
