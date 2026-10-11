"""The build: versions are tokens, outputs are guarded, pages are stamped."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from helpers import REPO, load_script

site = load_script("build_site")
DOMAIN = site.DOMAIN


@pytest.mark.parametrize("version", ["v1.2.3", "pr-abcdef0", "stage-abcdef0", "0"])
def test_a_version_token_is_accepted(version):
    assert site.normalise_version(version) == version


@pytest.mark.parametrize("version", ["", " ", "../x", "a b", "v1/2", "-x", "x" * 81, "a;b"])
def test_anything_that_is_not_one_token_is_refused(version):
    with pytest.raises(SystemExit):
        site.normalise_version(version)


def test_the_build_stamps_every_page_and_writes_the_sidecar_files(tmp_path):
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v9.9.9")
    assert (out / "version.txt").read_text() == "v9.9.9\n"
    assert (out / "robots.txt").read_text() == (
        f"User-agent: *\nAllow: /\n\nSitemap: https://{DOMAIN}/sitemap.xml\n"
    )
    assert (out / ".assetsignore").read_text() == ".site-build\n"
    for page in out.rglob("*.html"):
        text = page.read_text(encoding="utf-8")
        assert '<meta name="site-version" content="v9.9.9">' in text, page
        assert "{{version}}" not in text, page
    assert (out / "favicon.png").read_bytes() == (REPO / "src" / "favicon.png").read_bytes()


def test_a_preview_build_blocks_search_engines(tmp_path):
    site.build(REPO / "src", tmp_path / "site", "stage-abc1234", noindex=True)
    assert (tmp_path / "site" / "robots.txt").read_text() == "User-agent: *\nDisallow: /\n"
    # A preview must not advertise pages: no sitemap, whatever the domain.
    assert not (tmp_path / "site" / "sitemap.xml").exists()


def test_a_directory_that_is_not_a_previous_build_is_never_replaced(tmp_path):
    out = tmp_path / "site"
    out.mkdir()
    (out / "keep.txt").write_text("mine")
    with pytest.raises(SystemExit):
        site.build(REPO / "src", out, "v1")
    assert (out / "keep.txt").read_text() == "mine"


def test_a_sentinel_that_is_a_symlink_or_has_other_content_is_refused(tmp_path):
    victim = tmp_path / "victim.txt"
    victim.write_text(site.SENTINEL_TEXT)
    link_out = tmp_path / "linked"
    link_out.mkdir()
    (link_out / "keep.txt").write_text("mine")
    (link_out / ".site-build").symlink_to(victim)
    other = tmp_path / "other"
    other.mkdir()
    (other / "keep.txt").write_text("mine")
    (other / ".site-build").write_text("something else\n")
    for out in (link_out, other):
        with pytest.raises(SystemExit):
            site.build(REPO / "src", out, "v1")
        assert (out / "keep.txt").read_text() == "mine"
    assert victim.read_text() == site.SENTINEL_TEXT


def test_a_sentinel_that_is_a_directory_is_refused(tmp_path):
    out = tmp_path / "site"
    (out / site.SENTINEL).mkdir(parents=True)
    (out / "keep.txt").write_text("mine")
    with pytest.raises(SystemExit):
        site.build(REPO / "src", out, "v1")
    assert (out / "keep.txt").read_text() == "mine"
    assert (out / site.SENTINEL).is_dir()


def test_the_filesystem_root_is_never_a_valid_output(tmp_path, monkeypatch):
    # The guard must refuse before any deletion; if it ever does not, fail loudly here
    # instead of letting rmtree run against the real root.
    def forbidden(*args, **kwargs):
        raise AssertionError("the build reached a deletion for the filesystem root")

    monkeypatch.setattr(site.shutil, "rmtree", forbidden)
    with pytest.raises(SystemExit):
        site.build(REPO / "src", Path("/"), "v1")


def test_the_source_tree_is_never_a_valid_output(tmp_path):
    src = _copy_src(tmp_path)
    before = (src / "index.html").read_bytes()
    with pytest.raises(SystemExit):
        site.build(src, src, "v1")
    assert (src / "index.html").read_bytes() == before


def test_an_output_inside_the_source_is_refused_and_the_source_left_intact(tmp_path):
    src = _copy_src(tmp_path)
    before = {p: p.read_bytes() for p in src.rglob("*") if p.is_file()}
    with pytest.raises(SystemExit):
        site.build(src, src / "generated", "v1")
    assert {p: p.read_bytes() for p in src.rglob("*") if p.is_file()} == before
    assert not (src / "generated").exists()


def test_an_output_containing_the_source_is_refused_even_with_a_sentinel(tmp_path):
    out = tmp_path / "out"
    src = _copy_src(out)
    (out / site.SENTINEL).write_text(site.SENTINEL_TEXT, encoding="utf-8")
    before = {p: p.read_bytes() for p in src.rglob("*") if p.is_file()}
    with pytest.raises(SystemExit):
        site.build(src, out, "v1")
    assert {p: p.read_bytes() for p in src.rglob("*") if p.is_file()} == before


def test_a_symlinked_output_is_refused_and_its_target_left_intact(tmp_path):
    real = tmp_path / "real"
    site.build(REPO / "src", real, "v1")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(SystemExit):
        site.build(REPO / "src", link, "v2")
    assert (real / "version.txt").read_text() == "v1\n"


def test_a_real_previous_build_is_replaced(tmp_path):
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v1")
    site.build(REPO / "src", out, "v2")
    assert (out / "version.txt").read_text() == "v2\n"


def _copy_src(tmp_path):
    src = tmp_path / "src"
    for path in (REPO / "src").rglob("*"):
        if path.is_file():
            target = src / path.relative_to(REPO / "src")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
    return src


@pytest.mark.parametrize("name", ["team #1", "a b", "x?y", "50%", "Über"])
def test_a_page_path_outside_the_safe_alphabet_is_refused_naming_the_file(tmp_path, name):
    src = _copy_src(tmp_path)
    page = src / name / "index.html"
    page.parent.mkdir()
    page.write_text((src / "about" / "index.html").read_text(encoding="utf-8"), encoding="utf-8")
    with pytest.raises(SystemExit) as caught:
        site.build(src, tmp_path / "out", "v1")
    assert name in str(caught.value)
    assert not (tmp_path / "out").exists()


@pytest.mark.parametrize("name", ["contact", "team-1", "v2.0", "a_b", "0x"])
def test_ordinary_page_names_pass(tmp_path, name):
    src = _copy_src(tmp_path)
    page = src / name / "index.html"
    page.parent.mkdir()
    page.write_text((src / "about" / "index.html").read_text(encoding="utf-8"), encoding="utf-8")
    site.build(src, tmp_path / "out", "v1")


def test_the_repository_root_is_never_a_valid_output():
    with pytest.raises(SystemExit):
        site.build(REPO / "src", REPO, "v1")


def test_a_page_without_the_version_token_is_refused_before_anything_is_deleted(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    for name in site.REQUIRED:
        (src / name).write_text("x")
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v1")
    with pytest.raises(SystemExit):
        site.build(src, out, "v2")
    assert (out / "version.txt").read_text() == "v1\n"


def test_the_sitemap_lists_every_page_but_the_404_on_the_production_domain(tmp_path):
    out = tmp_path / "site"
    site.build(REPO / "src", out, "v1")
    text = (out / "sitemap.xml").read_text(encoding="utf-8")
    locs = re.findall(r"<loc>([^<]+)</loc>", text)
    assert locs == [
        f"https://{DOMAIN}{path}" for path in ("/", "/about/", "/compare/", "/timeline/")
    ]
    assert text.startswith('<?xml version="1.0" encoding="UTF-8"?>')
    assert "404" not in text


def test_a_new_page_is_added_to_the_sitemap_without_editing_the_build(tmp_path):
    src = tmp_path / "src"
    (src).mkdir()
    for path in (REPO / "src").rglob("*"):
        if path.is_file():
            target = src / path.relative_to(REPO / "src")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(path.read_bytes())
    extra = src / "contact" / "index.html"
    extra.parent.mkdir()
    extra.write_text((src / "about" / "index.html").read_text(encoding="utf-8"), encoding="utf-8")
    site.build(src, tmp_path / "out", "v1")
    text = (tmp_path / "out" / "sitemap.xml").read_text(encoding="utf-8")
    assert f"https://{DOMAIN}/contact/" in text


def test_the_domain_is_checked_and_escaped():
    with pytest.raises(SystemExit):
        site.build(REPO / "src", REPO / "dist-never", "v1", domain="Bad Domain/x")
    assert "&amp;" in site.sitemap(["/a?b&c"], "example.com")


def read_pages():
    for page in sorted((REPO / "src").rglob("*.html")):
        yield page.relative_to(REPO / "src").as_posix(), page.read_text(encoding="utf-8")


@pytest.mark.parametrize("name", ["index.html", "about/index.html"])
def test_a_page_head_carries_open_graph_and_twitter_meta_that_match_the_canonical_link(name):
    text = dict(read_pages())[name]

    def meta(attr, key):
        found = re.search(rf'<meta {attr}="{re.escape(key)}" content="([^"]*)">', text)
        assert found, f"{name} lacks {key}"
        return found.group(1)

    canonical = re.search(r'<link rel="canonical" href="([^"]+)">', text).group(1)
    assert meta("property", "og:url") == canonical
    assert meta("property", "og:title") == meta("name", "twitter:title")
    assert meta("property", "og:description") == meta("name", "twitter:description")
    assert meta("property", "og:title") and meta("property", "og:description")
    assert meta("property", "og:type") == "website"
    assert meta("name", "twitter:card") == "summary"
    assert meta("name", "description") == meta("property", "og:description")


def test_the_not_found_page_is_kept_out_of_search_results():
    assert '<meta name="robots" content="noindex">' in dict(read_pages())["404.html"]


@pytest.mark.parametrize("kind", ["file", "directory", "broken"])
def test_a_symlink_in_the_source_is_refused_naming_it(tmp_path, kind):
    src = _copy_src(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.env").write_text("SECRET=hunter2\n")
    link = src / "leak"
    target = {
        "file": outside / "secret.env",
        "directory": outside,
        "broken": outside / "missing",
    }[kind]
    link.symlink_to(target, target_is_directory=kind == "directory")
    out = tmp_path / "out"
    with pytest.raises(SystemExit) as refused:
        site.build(src, out, "v1")
    assert str(link) in str(refused.value)
    assert not out.exists()


def test_only_the_root_404_page_is_left_out_of_the_sitemap(tmp_path):
    src = tmp_path / "src"
    for relative in ("index.html", "404.html", "docs/404.html", "docs/index.html"):
        (src / relative).parent.mkdir(parents=True, exist_ok=True)
        (src / relative).write_text("<html></html>")
    pages = load_script("site_pages")
    assert pages.indexable_urls(src) == ["/", "/docs/404.html", "/docs/"]
    assert [p.relative_to(src).as_posix() for p in pages.page_files(src)][-1] == "404.html"
