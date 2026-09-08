"""Unit tests for Florence-2 OD output parsing (real <loc_> token format)."""
from app.florence import FlorenceDetector


def test_parse_single_object_with_special_tokens():
    # Real output from Florence-2-base (<s> bos leaks into the label via
    # skip_special_tokens=False).
    text = "</s><s>person<loc_0><loc_0><loc_998><loc_998></s>"
    objs = FlorenceDetector._parse(text)
    assert len(objs) == 1
    assert objs[0]["label"] == "person"
    assert objs[0]["bbox"] == [0.0, 0.0, 0.998, 0.998]


def test_parse_multiple_objects():
    text = (
        "<s>person<loc_100><loc_200><loc_300><loc_400>"
        "soccer ball<loc_500><loc_600><loc_700><loc_800>"
    )
    objs = FlorenceDetector._parse(text)
    assert len(objs) == 2
    assert objs[0]["label"] == "person"
    assert objs[1]["label"] == "soccer ball"
    assert objs[1]["bbox"] == [0.5, 0.6, 0.7, 0.8]


def test_parse_empty():
    assert FlorenceDetector._parse("<s></s>") == []
