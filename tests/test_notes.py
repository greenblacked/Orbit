"""src/data/notes.json: the owner's one-line descriptions of single releases."""

from __future__ import annotations

import json

from helpers import REPO, load_script

serve = load_script("serve_site")
NOTES = json.loads((REPO / "src" / "data" / "notes.json").read_text(encoding="utf-8"))
RELEASES = json.loads((REPO / "src" / "data" / "releases.json").read_text(encoding="utf-8"))


def test_the_file_has_exactly_the_documented_shape():
    assert set(NOTES) == {"schema", "notes"}
    assert NOTES["schema"] == 1
    assert isinstance(NOTES["notes"], dict)


def test_every_note_names_a_release_of_the_snapshot():
    ids = {release["id"] for release in RELEASES["releases"]}
    assert set(NOTES["notes"]) <= ids, sorted(set(NOTES["notes"]) - ids)


def test_every_note_is_a_clean_line_within_the_limit():
    for release_id, text in NOTES["notes"].items():
        assert isinstance(text, str), release_id
        assert text, release_id
        # Already what the Worker and the page would make of it, so what is written is what shows.
        assert serve.clean_summary(text) == text, release_id
        assert len(text.encode("utf-16-le")) // 2 <= serve.SUMMARY_MAX, release_id
        assert "<" not in text and ">" not in text, release_id


def test_the_cleaner_matches_the_worker_on_invisible_and_paired_characters():
    assert serve.clean_summary("a\u200bb\u202ec\ufeffd") == "abcd"
    out = serve.clean_summary("x" * 198 + "\U0001f600" * 5)
    assert out == "x" * 198 + "\u2026"
    assert len(out.encode("utf-16-le")) // 2 <= serve.SUMMARY_MAX


def test_every_summary_of_the_snapshot_is_clean():
    for release in RELEASES["releases"]:
        if "summary" in release:
            assert serve.clean_summary(release["summary"]) == release["summary"], release["id"]
