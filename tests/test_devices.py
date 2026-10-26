"""src/data/devices.json: the official Apple device list for each OS major."""

from __future__ import annotations

import json
import re
from datetime import date
from urllib.parse import urlparse

from helpers import REPO, load_script

DATA = REPO / "src" / "data"
DEVICES = json.loads((DATA / "devices.json").read_text(encoding="utf-8"))
FAMILIES = json.loads((DATA / "families.json").read_text(encoding="utf-8"))
RELEASES = json.loads((DATA / "releases.json").read_text(encoding="utf-8"))
SOURCE_HOSTS = ("www.apple.com", "support.apple.com")
DATE_RE = re.compile(r"^\d{4}-\d\d-\d\d$")


def lists():
    for family, majors in DEVICES["families"].items():
        for major, entry in majors.items():
            yield family, major, entry


def test_the_file_has_exactly_the_documented_shape():
    assert set(DEVICES) == {"schema", "checkedAt", "families"}
    assert DEVICES["schema"] == 1
    assert isinstance(DEVICES["families"], dict) and DEVICES["families"]


def test_checked_at_is_a_date():
    assert DATE_RE.fullmatch(DEVICES["checkedAt"])
    date.fromisoformat(DEVICES["checkedAt"])


def test_every_family_is_one_families_json_lists():
    ids = {family["id"] for family in FAMILIES["families"]}
    assert set(DEVICES["families"]) <= ids


def test_every_major_is_one_the_snapshot_lists_for_that_family():
    majors = {}
    for release in RELEASES["releases"]:
        majors.setdefault(release["family"], set()).add(str(release["major"]))
    for family, major, _ in lists():
        assert re.fullmatch(r"[1-9][0-9]*", major), (family, major)
        assert major in majors.get(family, set()), (family, major)


def test_each_list_has_exactly_the_documented_keys():
    for family, major, entry in lists():
        assert isinstance(entry, dict), (family, major)
        assert set(entry) == {"source", "default", "devices"}, (family, major)


def test_devices_are_unique_short_printable_ascii_strings():
    for family, major, entry in lists():
        devices = entry["devices"]
        assert isinstance(devices, list) and devices, (family, major)
        assert len(set(devices)) == len(devices), (family, major)
        for name in devices:
            assert isinstance(name, str) and name.strip(), (family, major, name)
            assert len(name) <= 60, (family, major, name)
            assert re.fullmatch(r"[\x20-\x7e]+", name), (family, major, name)
            assert name == name.strip(), (family, major, name)


def test_the_default_is_one_of_the_devices():
    for family, major, entry in lists():
        assert entry["default"] in entry["devices"], (family, major)


def test_the_source_is_an_https_url_on_an_apple_host():
    for family, major, entry in lists():
        url = urlparse(entry["source"])
        assert url.scheme == "https", (family, major)
        assert url.hostname in SOURCE_HOSTS, (family, major)
        assert not url.username and not url.password and url.port is None, (family, major)


def test_a_device_slug_is_a_safe_file_name_and_unique_within_its_list():
    check = load_script("check_results")
    for family, major, entry in lists():
        slugs = [check.device_slug(name) for name in entry["devices"]]
        assert all(check.NAME_RE.fullmatch(slug) for slug in slugs), (family, major)
        assert len(set(slugs)) == len(slugs), (family, major)
