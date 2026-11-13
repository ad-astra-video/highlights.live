"""ADAAAA-8405 — the headline's Phase C residuals, pinned at the contract text.

The Phase C grade (ADAAAA-8359) measured, over 255 emitted `postTitle` values on
the post-deploy build:

  * 7/255 carried a place phrase ("Players move in center", "Player falls in
    box" x3, "Player falls in penalty area", "Player stands in box");
  * 5/255 asserted a goal on a `not_highlight` / `big_play` row ("Ordonez
    scores");
  * 6/255 named a player the row's own copy never read, and 3/255 invented a
    first name onto a surname the copy DID read ("Ordonez scores" ->
    "Manuel Ordonez scores").

ADAAAA-8356's v2 paragraph named the bars but not the leak SHAPES: it banned a
"place" without naming `in/at/on` + zone, banned "a score claim" without listing
the vocabulary, and pinned names to "read it" without saying the name must be
transcribed EXACTLY. The v3 paragraph closes each set. These tests pin the
closed sets (so a later reword cannot quietly drop one) and pin the FULL (VOD)
contract BYTE-IDENTICAL — the live rail pays the prefill, the VOD rail pays
nothing.
"""
import hashlib

from app.gemma import _OUTPUT_CONTRACT_COMPACT, _OUTPUT_CONTRACT_FULL

# pre-change value (origin/master 4b68470): the VOD contract must not move
GOLDEN_FULL = (
    2909,
    "f61c4c9deeaebc1ee9d7065b95cea8435e9b345bffe41d39a3a33fbc487aeb24",
)


def test_vod_contract_is_byte_identical():
    """AC8 parity: the long-form (VOD) contract pays nothing for this fix."""
    assert (len(_OUTPUT_CONTRACT_FULL), hashlib.sha256(_OUTPUT_CONTRACT_FULL.encode()).hexdigest()) == GOLDEN_FULL


def test_place_ban_names_the_leak_shape_and_the_unit_fallback():
    """ADAAAA-8910: the headline is the NON-ASSERTING EVENT LABEL, so a place has
    no slot at all — the zone vocabulary is named as closed, exactly as 8405
    required, and the label set is the substitute the model writes instead."""
    c = _OUTPUT_CONTRACT_COMPACT
    for zone in ("place", "zone", "area", "box", "third", "wing", "venue", "stadium"):
        assert zone in c
    # the label set is closed and enumerated (the substitute for WHO/WHERE)
    for label in ("GOAL", "NEAR MISS", "BIG PLAY", "SHOT", "SAVE", "TACKLE"):
        assert label in c
    assert "NON-ASSERTING EVENT" in c
    # two words at most, so a label cannot grow back into a sentence
    assert "Two words at most" in c


def test_claim_ban_is_keyed_to_the_outcome_value_and_lists_the_vocabulary():
    c = _OUTPUT_CONTRACT_COMPACT
    # a GOAL label is allowed only on the model's OWN scoring verdict; every
    # other outcome has its own non-claiming label.
    assert "no goal claim unless YOUR OWN outcome here is scoring_play" in c
    assert "NEAR MISS (near_miss)" in c
    assert "BIG PLAY (big_play)" in c
    # a score/clock is never part of the label (the card composes the clip clock)
    assert "no clock, no score" in c
    assert "The card appends the" in c


def test_name_rule_closes_the_headline_to_names():
    """Four probe iterations on the deployed build still produced a player name
    read off an on-screen scorebug ("Manuel Ordonez scores") on a window whose
    transcript and OCR were both empty — the exact AC3 class, and not fixable by
    asking: the vision model treats the graphic as a read. The headline is now
    closed to names AND to role nouns (ADAAAA-8831 refuses a role-noun subject at
    the write seam, and ADAAAA-8910 removed the slot that required one), so 0
    absent names holds by construction; the CAPTION still names the player,
    grounded by the write seam's name gate."""
    c = _OUTPUT_CONTRACT_COMPACT
    assert "not from a scorebug or graphic in the frames" in c
    assert "not from the story, not from the match context" in c
    # the role vocabulary is spelled out AND named as refused (the 8910 lesson:
    # asking for a role while the gate refuses it stored 0/5 live titles)
    for role in ("keeper", "defender", "midfielder", "striker", "winger", "referee"):
        assert role in c
    assert "the write seam REFUSES it" in c
    assert "NO WHO slot and NO VERB slot" in c


def test_closed_verb_set_and_single_clause_kept():
    c = _OUTPUT_CONTRACT_COMPACT
    # ADAAAA-8910: no verb slot at all — the label carries the event, the caption
    # carries the play-by-play verb.
    assert "NO VERB slot" in c
    assert "ONE clause" in c
    assert "no trailing period" in c
    assert "delete every word except the label" in c


def test_caption_contract_is_untouched_by_this_fix():
    """The announcer contract still REQUIRES a place and keeps its colour/clock
    rules: only the headline's paragraph moved."""
    c = _OUTPUT_CONTRACT_COMPACT
    assert "the caption MUST name a place, the headline NEVER does" in c
    assert "total target max 110 chars, HARD MAX 140" in c
    assert "COLOR BEAT" in c
    # the headline key still precedes the caption key (the 8356 layout)
    assert c.index('"postTitle"') < c.index('"runningSummary"')
    assert c.index("POST TITLE RULES") > c.index('"runningSummary"')
