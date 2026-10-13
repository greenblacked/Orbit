"""Decision-level tests for the release gate scripts.

``read_wrangler_deploy`` decides which version a failed release rolls back to and whether
the custom domain was attached; ``check_job_results`` decides whether the aggregate gate
is green. Both are tables of input and verdict, so they are tested as tables.
"""

from __future__ import annotations

import json

import pytest
from helpers import load_script

reader = load_script("read_wrangler_deploy")
gate = load_script("check_job_results")

V1 = "11111111-2222-3333-4444-555555555555"
V2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
APEX = "https://orbit.acct.workers.dev"
PREVIEW_HOST = "https://pr-1.orbit.acct.workers.dev"


def line(**fields) -> str:
    return json.dumps(fields)


def deploy_line(targets, version_id=V1) -> str:
    fields = {"type": "deploy", "targets": targets}
    if version_id is not None:
        fields["version_id"] = version_id
    return line(**fields)


# parse_deploy -------------------------------------------------------------------------


def test_parse_deploy_reads_url_and_version():
    assert reader.parse_deploy(deploy_line([APEX]) + "\n") == (APEX, V1, "")


def test_parse_deploy_shortest_host_wins_in_either_order():
    for targets in ([PREVIEW_HOST, APEX], [APEX, PREVIEW_HOST]):
        assert reader.parse_deploy(deploy_line(targets)) == (APEX, V1, "")


@pytest.mark.parametrize(
    ("custom_target", "expected"),
    [
        ("orbit.szolotov.com (custom domain)", "https://orbit.szolotov.com"),
        (
            "orbit.szolotov.com (custom domain - zone name: szolotov.com) [previews: enabled]",
            "https://orbit.szolotov.com",
        ),
        ("orbit.szolotov.com (custom domain - zone id: abc123)", "https://orbit.szolotov.com"),
        ("orbit.szolotov.com", ""),
        ("orbit.szolotov.com (route)", ""),
        ("orbit.szolotov.com (custom domainX)", ""),
        ("orbit.szolotov.com (custom domain) [production: disabled]", ""),
        ("orbit.szolotov.com (custom domain - zone name: z) [production: disabled, x]", ""),
        ("orbit.szolotov.com.evil.com (custom domain)", ""),
        ("evil.orbit.szolotov.com (custom domain)", ""),
        ("ORBIT.szolotov.com (custom domain)", ""),
        ("https://orbit.szolotov.com (custom domain)", ""),
        ("(custom domain)", ""),
    ],
)
def test_parse_deploy_custom_domain_marker(custom_target, expected):
    url, version_id, custom = reader.parse_deploy(deploy_line([APEX, custom_target]))
    assert (url, version_id, custom) == (APEX, V1, expected)


@pytest.mark.parametrize(
    "bad_target",
    [
        "http://orbit.acct.workers.dev",
        "https://orbit.acct.workers.dev:8443",
        "https://orbit.acct.workers.dev/path",
        "https://orbit.acct.workers.dev/",
        "https://orbit.acct.workers.dev?x=1",
        "https://user@orbit.acct.workers.dev",
        "https://workers.dev",
        "https://ORBIT.acct.workers.dev",
        "https://-orbit.acct.workers.dev",
        "https://orbit.acct.example.com",
        "https://orbit.acct.workers.dev.evil.com",
        "orbit.acct.workers.dev",
        "",
        None,
        7,
        ["https://orbit.acct.workers.dev"],
    ],
)
def test_parse_deploy_drops_unacceptable_targets(bad_target):
    with pytest.raises(SystemExit, match="no https workers.dev target"):
        reader.parse_deploy(deploy_line([bad_target]))
    # An acceptable sibling still wins when the bad one is dropped.
    assert reader.parse_deploy(deploy_line([bad_target, APEX]))[0] == APEX


@pytest.mark.parametrize(
    "text",
    [
        "",
        "\n\n  \n",
        "not json\n",
        "{broken\n",
        "[1, 2]\n3\n",
        '"deploy"\n',
        line(type="preview", targets=[APEX]),
        line(type="upload", targets=[APEX]),
        line(targets=[APEX]),
        line(type="deploy"),
        line(type="deploy", targets=APEX),
        line(type="deploy", targets={"a": APEX}),
        line(type="deploy", targets=[]),
    ],
)
def test_parse_deploy_without_a_usable_deploy_line_is_an_error(text):
    with pytest.raises(SystemExit, match="no https workers.dev target"):
        reader.parse_deploy(text)


@pytest.mark.parametrize(
    "version_id",
    [None, "", "not-a-version", V2.upper(), V1[:-1], V1 + "0", 12345, ["x"], V1 + "\n"],
)
def test_parse_deploy_untrusted_version_id_is_empty(version_id):
    assert reader.parse_deploy(deploy_line([APEX], version_id)) == (APEX, "", "")


def test_parse_deploy_last_qualifying_line_wins_and_carries_its_own_fields():
    first = deploy_line([APEX, "orbit.szolotov.com (custom domain)"], V1)
    second = deploy_line(["https://other.acct.workers.dev"], V2)
    assert reader.parse_deploy(first + "\n" + second + "\n") == (
        "https://other.acct.workers.dev",
        V2,
        "",
    )


def test_parse_deploy_later_line_without_a_qualifying_target_does_not_replace():
    good = deploy_line([APEX], V1)
    later = deploy_line(["http://nope.workers.dev"], V2)
    assert reader.parse_deploy("\n".join([good, later])) == (APEX, V1, "")


def test_parse_deploy_skips_garbage_and_other_types_between_lines():
    text = "\n".join(
        ["garbage", "", line(type="upload", version_id=V2), deploy_line([APEX], V1), "{trunc"]
    )
    assert reader.parse_deploy(text) == (APEX, V1, "")


def test_parse_wrapper_drops_the_custom_url():
    text = deploy_line([APEX, "orbit.szolotov.com (custom domain)"])
    assert reader.parse(text) == (APEX, V1)


# parse_active -------------------------------------------------------------------------


def status(*versions) -> str:
    return json.dumps({"versions": [{"version_id": v, "percentage": p} for v, p in versions]})


@pytest.mark.parametrize("percentage", [100, 100.0])
def test_parse_active_single_version_at_full_traffic(percentage):
    assert reader.parse_active(status((V1, percentage))) == V1


def test_parse_active_ignores_extra_fields():
    text = json.dumps(
        {"id": "d", "source": "api", "versions": [{"version_id": V2, "percentage": 100}]}
    )
    assert reader.parse_active(text) == V2


@pytest.mark.parametrize(
    "text",
    [
        status((V1, 60), (V2, 40)),
        status((V1, 100), (V2, 0)),
        status((V1, 50.5), (V2, 49.5)),
        status((V1, 100), (V2, 100)),
        status((V1, 50)),
        status((V1, 0)),
        status((V1, 99.9)),
        status((V1, "100")),
        # Documents the intent of the bool guard; 1 != 100 fails either way.
        status((V1, True)),
        status((V1, None)),
        status(),
        json.dumps({"versions": ["x"]}),
        json.dumps({"versions": [None]}),
        json.dumps({"versions": [{"version_id": V1}]}),
    ],
)
def test_parse_active_rejects_anything_but_one_version_serving_everything(text):
    with pytest.raises(SystemExit, match="splits traffic"):
        reader.parse_active(text)


@pytest.mark.parametrize(
    "version_id",
    [None, "", "latest", V2.upper(), V1[:-1], 7, [V1], V1 + "\n"],
)
def test_parse_active_requires_a_real_version_id(version_id):
    with pytest.raises(SystemExit, match="not a version ID"):
        reader.parse_active(status((version_id, 100)))


@pytest.mark.parametrize("text", ["", "   ", "not json", "{", "Error: not logged in\n"])
def test_parse_active_non_json_is_an_error(text):
    with pytest.raises(SystemExit, match="did not print JSON"):
        reader.parse_active(text)


@pytest.mark.parametrize(
    "text",
    ["[]", "null", "3", '"x"', "{}", '{"versions": null}', '{"versions": {}}', '{"versions": "x"}'],
)
def test_parse_active_wrong_shape_lists_no_versions(text):
    with pytest.raises(SystemExit, match="lists no versions"):
        reader.parse_active(text)


# evaluate -----------------------------------------------------------------------------


def needs(**results) -> str:
    return json.dumps({job: {"result": result} for job, result in results.items()})


JOBS = ["lint", "test", "build"]


def test_evaluate_all_success_passes_with_rows_in_expected_order():
    raw = needs(build="success", lint="success", test="success")
    assert gate.evaluate(JOBS, raw) == (
        True,
        [("lint", "success"), ("test", "success"), ("build", "success")],
    )


@pytest.mark.parametrize(
    ("results", "skippable", "passed"),
    [
        # success and skipped
        (("success", "success", "success"), [], True),
        (("success", "success", "success"), ["build"], True),
        (("success", "success", "skipped"), ["build"], True),
        (("skipped", "success", "skipped"), ["lint", "build"], True),
        (("skipped", "skipped", "skipped"), ["lint", "test", "build"], True),
        (("success", "success", "skipped"), [], False),
        (("success", "skipped", "success"), ["build"], False),
        (("skipped", "success", "success"), ["build"], False),
        # failure and cancelled never pass, listed or not
        (("success", "success", "failure"), [], False),
        (("success", "success", "failure"), ["build"], False),
        (("success", "success", "cancelled"), [], False),
        (("success", "success", "cancelled"), ["build"], False),
        (("failure", "cancelled", "skipped"), ["build"], False),
        (("failure", "failure", "failure"), ["lint", "test", "build"], False),
        (("cancelled", "cancelled", "cancelled"), ["lint", "test", "build"], False),
        # one bad job among good ones
        (("failure", "success", "success"), [], False),
        (("success", "cancelled", "success"), [], False),
    ],
)
def test_evaluate_results_table(results, skippable, passed):
    raw = needs(**dict(zip(JOBS, results, strict=True)))
    verdict, rows = gate.evaluate(JOBS, raw, skippable)
    assert verdict is passed
    assert rows == list(zip(JOBS, results, strict=True))


def test_evaluate_skippable_none_and_empty_behave_the_same():
    raw = needs(lint="success", test="success", build="skipped")
    assert gate.evaluate(JOBS, raw) == gate.evaluate(JOBS, raw, None)
    assert gate.evaluate(JOBS, raw, []) == gate.evaluate(JOBS, raw, None)


def test_evaluate_does_not_mutate_the_skippable_argument():
    skippable = ["build"]
    gate.evaluate(JOBS, needs(lint="success", test="success", build="skipped"), skippable)
    assert skippable == ["build"]


@pytest.mark.parametrize(
    "expected",
    [[], ["lint", "lint"], ["lint", "bad id"], ["lint", ""], ["a/b"], ["x;y"], ["lint\n"]],
)
def test_evaluate_bad_expected_list_fails_with_no_rows(expected):
    assert gate.evaluate(expected, needs(lint="success")) == (False, [])


@pytest.mark.parametrize("skippable", [["other"], ["build", "other"], ["bad id"], [""]])
def test_evaluate_skippable_outside_expected_fails_as_invalid(skippable):
    raw = needs(lint="success", test="success", build="success")
    assert gate.evaluate(JOBS, raw, skippable) == (False, [(job, "invalid") for job in JOBS])


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "not json",
        "{",
        123,
        "[]",
        "null",
        '"x"',
        "7",
        # duplicate member name
        '{"lint": {"result": "failure"}, "lint": {"result": "success"}, '
        '"test": {"result": "success"}, "build": {"result": "success"}}',
        # missing and extra jobs
        needs(lint="success", test="success"),
        needs(lint="success", test="success", build="success", extra="success"),
        needs(lint="success", test="success", other="success"),
        "{}",
    ],
)
def test_evaluate_missing_or_malformed_needs_fails_closed(raw):
    assert gate.evaluate(JOBS, raw) == (False, [(job, "invalid") for job in JOBS])


@pytest.mark.parametrize(
    "entry",
    [None, "success", 1, ["success"], {}, {"result": None}, {"result": 5}, {"result": ["success"]}],
)
def test_evaluate_malformed_entry_is_invalid_and_fails(entry):
    raw = json.dumps({"lint": {"result": "success"}, "test": entry, "build": {"result": "success"}})
    assert gate.evaluate(JOBS, raw) == (
        False,
        [("lint", "success"), ("test", "invalid"), ("build", "success")],
    )


@pytest.mark.parametrize(
    "result", ["Success", "SUCCESS", "ok", "passed", "", "<b>x</b>", "success "]
)
def test_evaluate_unknown_result_is_never_reflected_and_never_passes(result):
    raw = needs(lint="success", test=result, build="success")
    assert gate.evaluate(JOBS, raw, ["test"]) == (
        False,
        [("lint", "success"), ("test", "invalid"), ("build", "success")],
    )


def test_evaluate_ignores_other_fields_of_a_successful_entry():
    raw = json.dumps({"lint": {"result": "success", "outputs": {"a": "b"}, "x": [1]}})
    assert gate.evaluate(["lint"], raw) == (True, [("lint", "success")])


def test_evaluate_single_job():
    assert gate.evaluate(["ci"], needs(ci="success")) == (True, [("ci", "success")])
    assert gate.evaluate(["ci"], needs(ci="skipped")) == (False, [("ci", "skipped")])
    assert gate.evaluate(["ci"], needs(ci="skipped"), ["ci"]) == (True, [("ci", "skipped")])


# append_summary and main --------------------------------------------------------------


def test_append_summary_without_a_path_succeeds_and_writes_nothing():
    assert gate.append_summary(None, [("lint", "success")]) is True
    assert gate.append_summary("", [("lint", "success")]) is True


def test_append_summary_appends_a_table(tmp_path):
    path = tmp_path / "summary.md"
    path.write_text("before\n", encoding="utf-8")
    assert gate.append_summary(str(path), [("lint", "success"), ("test", "skipped")]) is True
    assert path.read_text(encoding="utf-8") == (
        "before\n| Job | Result |\n| --- | --- |\n| `lint` | success |\n| `test` | skipped |\n"
    )


def test_append_summary_reports_an_unwritable_path(tmp_path):
    assert gate.append_summary(str(tmp_path), [("lint", "success")]) is False


@pytest.mark.parametrize(
    ("env", "code"),
    [
        ({"NEEDS_JSON": needs(lint="success", test="success")}, 0),
        ({"NEEDS_JSON": needs(lint="success", test="skipped")}, 1),
        ({"NEEDS_JSON": needs(lint="success", test="skipped"), "SKIPPABLE": "test"}, 0),
        ({"NEEDS_JSON": needs(lint="success", test="skipped"), "SKIPPABLE": "test other"}, 1),
        ({"NEEDS_JSON": needs(lint="success", test="cancelled"), "SKIPPABLE": "test"}, 1),
        ({}, 1),
    ],
)
def test_main_exit_code(monkeypatch, capsys, env, code):
    for name in ("NEEDS_JSON", "SKIPPABLE", "GITHUB_STEP_SUMMARY"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert gate.main(["lint", "test"]) == code
    captured = capsys.readouterr()
    if code == 0:
        assert "all 2 required job(s) succeeded" in captured.out
    else:
        assert "did not satisfy" in captured.err
        assert captured.out == ""


def test_main_fails_when_the_summary_cannot_be_written(monkeypatch, tmp_path):
    monkeypatch.delenv("SKIPPABLE", raising=False)
    monkeypatch.setenv("NEEDS_JSON", needs(lint="success"))
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(tmp_path))
    assert gate.main(["lint"]) == 1
