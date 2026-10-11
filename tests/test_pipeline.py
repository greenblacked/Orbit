"""The CI/CD files say what the documentation says they do.

There is no YAML parser in the standard library, so these read the workflow text. They
look for the few lines each invariant lives on; a reformat that moves them is a reason to
read the test, not to loosen it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest
from helpers import load_script

REPO = Path(__file__).resolve().parent.parent
WORKFLOWS = REPO / ".github" / "workflows"


def workflow(name: str) -> str:
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def job_ids(text: str) -> list[str]:
    """The job ids under the top-level ``jobs:`` key, in file order."""
    body = text.split("\njobs:\n", 1)[1]
    return re.findall(r"^  ([A-Za-z0-9_-]+):\s*$", body, flags=re.MULTILINE)


def job_block(text: str, job: str) -> str:
    body = text.split("\njobs:\n", 1)[1]
    match = re.search(rf"^  {re.escape(job)}:\s*$", body, flags=re.MULTILINE)
    assert match, f"no job {job}"
    rest = body[match.end() :]
    following = re.search(r"^  [A-Za-z0-9_-]+:\s*$", rest, flags=re.MULTILINE)
    return rest[: following.start()] if following else rest


def needs_of(text: str, job: str) -> list[str]:
    block = job_block(text, job)
    match = re.search(r"^    needs:\n((?:      - .+\n)+)", block, flags=re.MULTILINE)
    assert match, f"{job} has no needs list"
    return [line.strip()[2:] for line in match.group(1).splitlines()]


def test_the_aggregate_ci_job_needs_every_other_job():
    ci = workflow("ci.yml")
    others = [job for job in job_ids(ci) if job != "ci"]
    assert sorted(needs_of(ci, "ci")) == sorted(others)
    # The gate script is handed the same names, so a job cannot be listed and ignored.
    call = re.search(r"check_job_results\.py \\\n\s+(.+)", ci)
    assert call
    assert sorted(call.group(1).split()) == sorted(others)


def test_the_branch_name_job_runs_on_pull_requests_and_reads_the_ref_from_env():
    ci = workflow("ci.yml")
    block = job_block(ci, "branch-name")
    assert "github.event_name == 'pull_request'" in block
    assert "HEAD_REF: ${{ github.head_ref }}" in block
    assert "scripts/check_branch_name.py" in block
    for run in re.findall(r"run: \|\n((?:          .*\n?)+)", block):
        assert "${{" not in run, "an expression inside a run: block is shell injection"
    # Skipped is acceptable for this job only: the value is parsed and compared exactly,
    # because a substring check passes `branch-name smoke` and the gate goes green with
    # a required job skipped.
    skippable = re.search(r"^\s+SKIPPABLE: (.*)$", ci, flags=re.MULTILINE)
    assert skippable, "ci has no SKIPPABLE value"
    assert skippable.group(1).split() == ["branch-name"]
    assert len(re.findall(r"SKIPPABLE:", ci)) == 1


def test_no_run_block_expands_an_expression_in_any_workflow():
    for path in sorted(WORKFLOWS.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        for run in re.findall(r"^ +run: [|>][-+]?\n((?: {10,}.*\n|\n)+)", text, flags=re.MULTILINE):
            assert "${{" not in run, f"{path.name}: an expression inside a run: block"


# One canonical X.Y.Z: each component is 0 or starts with 1-9, so 01.2.3 is not a version.
_PART = "(0|[1-9][0-9]*)"
CANONICAL = rf"{_PART}\.{_PART}\.{_PART}$"


def _bash_matches(pattern: str, value: str) -> bool:
    import subprocess

    done = subprocess.run(  # noqa: S603 - fixed argv; the value is data, not code
        ["bash", "-c", '[[ "$1" =~ $2 ]]', "bash", value, pattern],  # noqa: S607
        check=False,
    )
    return done.returncode == 0


@pytest.mark.parametrize(
    ("value", "ok"),
    [
        ("1.2.3", True),
        ("0.0.0", True),
        ("10.0.0", True),
        ("1.20.300", True),
        ("01.2.3", False),
        ("1.02.3", False),
        ("1.2.03", False),
        ("00.0.0", False),
        ("1.2", False),
        ("1.2.3.4", False),
        ("v1.2.3", False),
    ],
)
def test_the_canonical_version_pattern_rejects_leading_zeros(value, ok):
    assert _bash_matches("^" + CANONICAL, value) is ok


def test_every_version_check_uses_the_canonical_pattern_and_no_loose_one():
    for name in ("release.yml", "cut-release.yml"):
        text = workflow(name)
        assert "[0-9]+\\.[0-9]+\\.[0-9]+" not in text, name
    assert "tags: ['v[0-9]+.[0-9]+.[0-9]+']" in workflow("release.yml")  # a glob; the job re-checks
    cut = workflow("cut-release.yml")
    assert "sort -V" not in cut, "sort -V and int() disagree on leading zeros"
    assert 'check_release_order.py" --include-equal "v$VERSION"' in cut


def test_every_workflow_sets_permissions_and_every_job_a_timeout():
    for path in sorted(WORKFLOWS.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        assert re.search(r"^permissions: \{\}$", text, flags=re.MULTILINE), path.name
        for job in job_ids(text):
            assert "timeout-minutes:" in job_block(text, job), f"{path.name}: {job}"


# --- release invariants ---------------------------------------------------------------


def test_release_runs_on_a_version_tag_and_nothing_else_publishes():
    release = workflow("release.yml")
    assert "tags: ['v[0-9]+.[0-9]+.[0-9]+']" in release
    for job in ("release", "cloudflare"):
        block = job_block(release, job)
        assert '"$GITHUB_REF_TYPE" != "tag"' in block, job
        assert "^v" + CANONICAL in block, job
    # Production is deployed by this workflow alone.
    for name in ("ci.yml", "deploy.yml", "security.yml", "cut-release.yml"):
        assert "environment:\n      name: production" not in workflow(name), name
    assert "name: production" in job_block(release, "cloudflare")


def test_release_checks_the_tag_is_an_ancestor_of_origin_main_in_both_jobs():
    release = workflow("release.yml")
    check = 'git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main'
    for job in ("release", "cloudflare"):
        block = job_block(release, job)
        assert check in block, job
        # The history must be there for the check to mean anything.
        assert "fetch-depth: 0" in block, job


def test_release_verifies_on_workers_dev_and_rolls_back_on_failure():
    block = job_block(workflow("release.yml"), "cloudflare")
    assert 'scripts/smoke_site.sh "$WORKERS_DEV_URL" "$TAG"' in block
    assert "--active-is" in block
    assert "if: failure() && steps.deploy.outputs.deployed == 'true'" in block
    assert 'wrangler rollback "$PREVIOUS_VERSION_ID"' in block
    assert "deployed=true" in block


def test_the_worker_serves_a_404_page_and_keeps_workers_dev():
    config = json.loads((REPO / "deploy" / "wrangler.json").read_text(encoding="utf-8"))
    assert config["assets"]["not_found_handling"] == "404-page"
    assert config["assets"]["directory"] == "../dist/site"
    # The release is verified on workers.dev; without it the release fails by design.
    assert config["workers_dev"] is True
    (route,) = config["routes"]
    assert route["custom_domain"] is True
    assert route["previews_enabled"] is True


def test_the_stage_preview_uploads_from_the_main_branch_only():
    deploy = workflow("deploy.yml")
    assert re.search(r"^  push:\n    branches: \[main\]$", deploy, flags=re.MULTILINE)
    preview = job_block(deploy, "preview")
    assert "github.event_name == 'push' || github.event_name == 'workflow_dispatch'" in preview
    assert '[ "$REF_TYPE" != branch ] || [ "$REF_NAME" != main ]' in preview
    assert "name: staging" in preview
    assert "--name stage" in preview
    assert "--noindex" in preview
    # There is no stage branch: nothing in the file triggers on, checks or reads one.
    assert "branches: [stage]" not in deploy
    assert '"$REF_NAME" != stage' not in deploy
    assert "heads/stage" not in deploy


def test_a_pull_request_only_dry_runs_and_holds_no_credential():
    deploy = workflow("deploy.yml")
    dry = job_block(deploy, "dry-run")
    assert "if: github.event_name == 'pull_request'" in dry
    assert "--dry-run" in dry
    assert "secrets." not in dry
    assert "environment:" not in dry
    assert "CLOUDFLARE_API_TOKEN" not in dry
    # The preview is the only job in the file that names the token.
    assert "CLOUDFLARE_API_TOKEN" in job_block(deploy, "preview")


def test_there_is_no_deploy_branch_and_no_stage_branch():
    for path in sorted(WORKFLOWS.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        for branches in re.findall(r"branches: \[([^\]]*)\]", text):
            names = {name.strip() for name in branches.split(",")}
            assert names <= {"main", "dev"}, (path.name, names)
        assert "heads/stage" not in text, path.name


def test_ci_and_security_run_on_pushes_to_main_and_dev_and_on_pull_requests():
    for name in ("ci.yml", "security.yml"):
        text = workflow(name)
        head = text.split("\njobs:\n", 1)[0]
        assert re.search(r"^  push:\n    branches: \[main, dev\]$", head, flags=re.MULTILINE), name
        assert re.search(r"^  pull_request:", head, flags=re.MULTILINE), name
        assert "pull_request_target" not in head, name


def test_cut_release_runs_on_main_only_and_dispatches_release_on_the_tag():
    cut = workflow("cut-release.yml")
    assert '"$GITHUB_REF" != "refs/heads/main"' in cut
    assert 'gh workflow run release.yml --ref "v$VERSION"' in cut
    assert "^" + CANONICAL in cut
    assert "VERSION: ${{ inputs.version }}" in cut


def test_dependabot_follows_dev_then_main():
    config = (REPO / ".github" / "dependabot.yml").read_text(encoding="utf-8")
    assert re.search(r"^    target-branch: dev$", config, flags=re.MULTILINE)
    assert not re.search(r"^\s*target-branch: (?!dev$)", config, flags=re.MULTILINE)


def test_auto_merge_only_acts_on_a_pull_request_into_dev():
    text = workflow("dependabot-auto-merge.yml")
    assert "github.event.pull_request.base.ref == 'dev'" in text
    # The header must not claim a ruleset mode that SETUP never asks for.
    assert "strict" not in text


def _run_block(block: str) -> str:
    """The shell of the job's single ``run: |`` step, de-indented as the runner sees it."""
    runs = re.findall(r"run: \|\n((?:          .*\n|\n)+)", block)
    assert len(runs) == 1, "the job is one run step"
    return "".join(line[10:] if line.strip() else line for line in runs[0].splitlines(True))


def test_auto_merge_runs_no_action_and_no_pull_request_code():
    """Nothing Dependabot can edit may change what runs with the write token.

    Under `pull_request` the workflow and its `uses:` refs come from the pull request, and
    a step `if:` does not stop an action's `pre` entry, so the job has no `uses:` line at
    all. `pull_request_target` is not an option: GitHub blocks it on public repositories
    without an event policy from 2026-11-02.
    """
    text = workflow("dependabot-auto-merge.yml")
    trigger = text.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
    assert re.search(r"^  pull_request:", trigger, flags=re.MULTILINE)
    assert "pull_request_target" not in trigger
    assert "zizmor: ignore" not in text, "no suppression"
    block = job_block(text, "auto-merge")
    assert not re.search(r"^\s*(- )?uses:", text, flags=re.MULTILINE), "no action at all"
    assert "actions/checkout" not in text, "a checkout would put pull request code on disk"
    assert "github.event.pull_request.head.ref" not in block
    assert "github.head_ref" not in block
    run = _run_block(block)
    assert "${{" not in run, "an expression inside run: is shell injection"
    assert "set -Eeuo pipefail" in run
    condition = block.split("    if: >-", 1)[1].split("    permissions:", 1)[0]
    assert "github.actor" not in condition, "zizmor bot-conditions: the actor is spoofable"
    assert "github.event.pull_request.user.login == 'dependabot[bot]'" in condition
    assert "github.event.pull_request.head.repo.full_name == github.repository" in condition
    assert "github.event.pull_request.base.ref == 'dev'" in condition
    assert "permissions: {}" in text
    assert "      contents: write\n      pull-requests: write\n" in block
    for env in (
        "PR_NUMBER: ${{ github.event.pull_request.number }}",
        "PR_URL: ${{ github.event.pull_request.html_url }}",
        "GH_TOKEN: ${{ github.token }}",
        "REPO: ${{ github.repository }}",
    ):
        assert env in block


def _commit(login: str | None, *updates: str, block: bool = True, verified: bool = True) -> str:
    """One line of the commits listing: Dependabot's message shape, or a plain one."""
    message = "Bump the thing\n\nBumps thing.\n"
    if block:
        message += "\n---\nupdated-dependencies:\n"
        for n, kind in enumerate(updates):
            message += (
                f"- dependency-name: dep{n}\n  dependency-version: 1.0.{n}\n"
                f"  dependency-type: direct:production\n  update-type: {kind}\n"
            )
        message += "...\n"
    return json.dumps({"login": login, "verified": verified, "message": message})


def _run_auto_merge(
    tmp_path,
    commits: list[str],
    allow: str = "true",
    armed: bool = False,
    disable_fails: bool = False,
    expect_ok: bool = True,
) -> tuple[str, list[str]]:
    """Execute the workflow's own run block against a stub ``gh``.

    Returns the combined output and the ``gh pr merge`` calls the script made. ``armed``
    is whether the stub reports auto-merge already on; ``disable_fails`` makes
    ``--disable-auto`` exit non-zero.
    """
    block = job_block(workflow("dependabot-auto-merge.yml"), "auto-merge")
    (tmp_path / "run.sh").write_text(_run_block(block), encoding="utf-8")
    (tmp_path / "commits.jsonl").write_text("\n".join(commits) + "\n", encoding="utf-8")
    calls = tmp_path / "calls.log"
    stub = tmp_path / "bin" / "gh"
    stub.parent.mkdir()
    stub.write_text(
        "#!/usr/bin/env bash\n"
        'case "$1 $2" in\n'
        '  "api "*"/pulls/7/commits") cat "$FIXTURE" ;;\n'
        f'  "api "*) echo "{allow}" ;;\n'
        '  "pr view") echo "$ARMED" ;;\n'
        '  "pr merge") echo "$*" >> "$CALLS"; '
        'if [ "$3" = "--disable-auto" ] && [ -n "$DISABLE_FAILS" ]; then exit 1; fi ;;\n'
        '  *) echo "unexpected gh $*" >&2; exit 9 ;;\n'
        "esac\n",
        encoding="utf-8",
    )
    stub.chmod(0o755)
    env = {
        "PATH": f"{stub.parent}:{os.environ['PATH']}",
        "FIXTURE": str(tmp_path / "commits.jsonl"),
        "CALLS": str(calls),
        "ARMED": "true" if armed else "false",
        "DISABLE_FAILS": "1" if disable_fails else "",
        "PR_NUMBER": "7",
        "PR_URL": "https://github.com/o/r/pull/7",
        "GH_TOKEN": "x",
        "REPO": "o/r",
        "GITHUB_STEP_SUMMARY": str(tmp_path / "summary.md"),
    }
    done = subprocess.run(  # noqa: S603 - fixed argv; the script under test is the workflow's
        ["bash", str(tmp_path / "run.sh")],  # noqa: S607 - bash from PATH is intended
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert (done.returncode == 0) == expect_ok, done.stdout + done.stderr
    merges = calls.read_text(encoding="utf-8").splitlines() if calls.exists() else []
    return done.stdout + done.stderr, merges


MINOR = "version-update:semver-minor"
PATCH = "version-update:semver-patch"
MAJOR = "version-update:semver-major"
BOT = "dependabot[bot]"


@pytest.mark.parametrize(
    "commits",
    [
        [_commit(BOT, PATCH)],
        [_commit(BOT, MINOR)],
        [_commit(BOT, MINOR, PATCH, MINOR)],
        [_commit(BOT, PATCH), _commit(BOT, MINOR)],
    ],
    ids=["patch", "minor", "grouped", "two-commits"],
)
def test_auto_merge_enables_merge_for_minor_and_patch_only(tmp_path, commits):
    out, merges = _run_auto_merge(tmp_path, commits)
    assert merges == ["pr merge --auto --squash https://github.com/o/r/pull/7"], out


@pytest.mark.parametrize(
    ("commits", "reason"),
    [
        ([_commit(BOT, MAJOR)], "minor or patch"),
        ([_commit(BOT, PATCH, MAJOR)], "minor or patch"),
        ([_commit(BOT, PATCH), _commit(BOT, MAJOR)], "minor or patch"),
        ([_commit(BOT, "version-update:semver-unknown")], "minor or patch"),
        ([_commit(BOT, block=False)], "no Dependabot metadata"),
        ([_commit(BOT, PATCH), _commit("someone", PATCH)], "not authored by dependabot"),
        ([_commit(None, PATCH)], "not authored by dependabot"),
        ([_commit("someone", PATCH)], "not authored by dependabot"),
        ([_commit(BOT, PATCH, verified=False)], "not verified by GitHub"),
        ([_commit(BOT, PATCH), _commit(BOT, PATCH, verified=False)], "not verified by GitHub"),
        ([], "no commits"),
        (["not json"], "could not be read"),
    ],
    ids=[
        "major",
        "grouped-mixed",
        "major-in-second-commit",
        "unclassified",
        "missing-block",
        "human-commit-after-bot",
        "unlinked-author",
        "human-only",
        "unverified",
        "unverified-second-commit",
        "no-commits",
        "garbage",
    ],
)
def test_auto_merge_leaves_everything_else_for_a_person(tmp_path, commits, reason):
    out, merges = _run_auto_merge(tmp_path, commits)
    assert merges == [], out
    assert "::notice" in out
    assert reason in out


def test_auto_merge_turns_off_an_earlier_request_when_a_push_makes_it_ineligible(tmp_path):
    out, merges = _run_auto_merge(tmp_path, [_commit(BOT, MAJOR)], armed=True)
    assert merges == ["pr merge --disable-auto https://github.com/o/r/pull/7"], out


def test_auto_merge_does_not_disable_what_is_not_on(tmp_path):
    out, merges = _run_auto_merge(tmp_path, [_commit(BOT, MAJOR)], armed=False)
    assert merges == [], out


def test_auto_merge_fails_loudly_when_it_cannot_turn_auto_merge_off(tmp_path):
    out, merges = _run_auto_merge(
        tmp_path,
        [_commit("someone", PATCH)],
        armed=True,
        disable_fails=True,
        expect_ok=False,
    )
    assert merges == ["pr merge --disable-auto https://github.com/o/r/pull/7"], out


def test_auto_merge_leaves_the_pull_request_when_the_repository_disallows_it(tmp_path):
    out, merges = _run_auto_merge(tmp_path, [_commit(BOT, PATCH)], allow="false")
    assert merges == []
    assert "::warning title=auto-merge disabled" in out


def test_every_workflow_pins_the_same_wrangler_as_the_lockfile():
    """Runs in ci's build job, so a pin that drifts fails a required check.

    The dry-run job in deploy.yml checks only its own workflow's pin and is not required,
    so release.yml's pin would otherwise be first read at release time.
    """
    pins = {}
    for path in sorted(WORKFLOWS.glob("*.yml")):
        found = re.findall(r"^\s*WRANGLER_VERSION: '([^']+)'\s*$", path.read_text(), re.M)
        if found:
            pins[path.name] = set(found)
    assert {"deploy.yml", "release.yml"} <= set(pins), pins
    versions = set().union(*pins.values())
    assert len(versions) == 1, pins
    (version,) = versions
    assert load_script("check_wrangler_pin").problems(REPO, version) == []


def test_the_browser_job_runs_the_preview_loop_and_keeps_its_output():
    block = job_block(workflow("ci.yml"), "site-browser")
    assert "bash scripts/preview.sh" in block
    assert "BROWSER_CHANNEL: chrome" in block
    assert "actions/upload-artifact@" in block
    assert "path: dist/preview" in block
    assert "if: always()" in block


def test_the_agent_instructions_state_the_workflow_and_stay_public_safe():
    agents = (REPO / "AGENTS.md").read_text(encoding="utf-8")
    assert (REPO / "CLAUDE.md").read_text(encoding="utf-8").strip() == "@AGENTS.md"
    for needle in (
        "<type>/<kebab>",
        "`dev` to `main`",
        "bash scripts/preview.sh",
        "phone, tablet and desktop",
        "dist/preview/index.html",
        "https://stage.",
        "Cut release",
    ):
        assert needle in agents, needle
    # There is no stage branch, so the agent rules must not describe one.
    assert "`stage` to `main`" not in agents
    assert "`dev` to `stage`" not in agents
    # The docs describe this repository only: no absolute or home-directory paths.
    for name in ("AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "README.md", "SETUP.md"):
        text = (REPO / name).read_text(encoding="utf-8")
        assert "/home/" not in text and "~/" not in text, name


def test_setup_and_the_template_checklist_protect_release_tags():
    setup = (REPO / "SETUP.md").read_text(encoding="utf-8")
    assert "refs/tags/v*" in setup
    # Creation stays open: Cut release creates the tag with GITHUB_TOKEN, which cannot be
    # a ruleset bypass actor, so a ruleset restricting creation would break every release.
    assert "restricts updates and deletion" in setup
    assert "does **not** restrict creation" in setup
    assert "bypass the ruleset" not in setup
    assert "GitHub Actions app" not in setup
    assert "run **Cut release** once" in setup


def test_the_deploy_refuses_to_overwrite_a_newer_release():
    block = job_block(workflow("release.yml"), "cloudflare")
    steps = block.split("\n      - ")
    names = [step.split("\n", 1)[0] for step in steps]
    guard = next(i for i, name in enumerate(names) if "newer release" in name)
    deploy = next(i for i, name in enumerate(names) if name == "name: Deploy the production Worker")
    assert guard < deploy, "the guard must run before the deploy"
    text = steps[guard]
    assert 'python "$GITHUB_WORKSPACE/scripts/check_release_order.py" "$TAG"' in text
    assert "git/matching-refs/tags/v" in text and "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}" in text
    assert "set -Eeuo pipefail" in text


def test_the_release_order_check_rejects_older_and_accepts_the_newest():
    order = load_script("check_release_order")
    existing = ["refs/tags/v1.9.0", "v1.10.0", "v1.2.3", "refs/tags/vnext", "v2.0.0-rc1"]
    assert order.newer_tags("v1.9.0", existing) == ["v1.10.0"], "numeric, not lexical"
    assert order.newer_tags("v1.10.0", existing) == []
    assert order.newer_tags("v1.2.3", existing) == ["v1.9.0", "v1.10.0"]
    assert order.newer_tags("v1.10.0", []) == []
    assert order.newer_tags("v1.10.0", ["v1.10.0"]) == [], "the run's own tag is not newer"


def test_the_release_order_check_exits_nonzero_for_an_older_tag(monkeypatch, capsys):
    import io

    order = load_script("check_release_order")

    def run(tag, tags):
        monkeypatch.setattr("sys.stdin", io.StringIO(tags))
        return order.main([tag])

    assert run("v1.0.0", "refs/tags/v1.0.0\nrefs/tags/v1.0.1\n") == 1
    assert "v1.0.1" in capsys.readouterr().err
    assert run("v1.0.1", "refs/tags/v1.0.0\nrefs/tags/v1.0.1\n") == 0
    assert run("main", "") == 2


@pytest.mark.parametrize("tag", ["v01.2.3", "v1.02.3", "v1.2.03", "1.2.3", "v1.2", "main"])
def test_the_release_order_check_refuses_a_tag_that_is_not_canonical(tag):
    order = load_script("check_release_order")
    with pytest.raises(ValueError):
        order.newer_tags(tag, [])


def test_a_non_canonical_existing_tag_still_counts_as_the_number_it_spells():
    order = load_script("check_release_order")
    # v01.2.3 is not a version this repository cuts, but a hand-pushed one must not let an
    # older release through: it counts as 1.2.3 and is named as written.
    assert order.newer_tags("v1.2.0", ["v01.2.3"]) == ["v01.2.3"]
    assert order.newer_tags("v1.2.3", ["v01.2.3"]) == []
    assert order.newer_tags("v1.2.3", ["v01.2.3"], include_equal=True) == ["v01.2.3"]
    assert order.newer_tags("v10.0.0", ["v9.0.0", "v0.0.0", "v1.02.3"]) == []
    assert order.newer_tags("v1.0.0", ["v10.0.0", "v0.0.0"]) == ["v10.0.0"]


def test_the_release_order_check_include_equal_flag(monkeypatch, capsys):
    import io

    order = load_script("check_release_order")
    monkeypatch.setattr("sys.stdin", io.StringIO("v1.2.3\n"))
    assert order.main(["--include-equal", "v1.2.3"]) == 1
    monkeypatch.setattr("sys.stdin", io.StringIO("v1.2.3\n"))
    assert order.main(["v1.2.3"]) == 0


# --- a superseded stage run must not upload over the tip of main ----------------------


def test_only_pull_request_runs_are_cancelled_and_stage_runs_queue():
    deploy = workflow("deploy.yml")
    head = deploy.split("\njobs:\n", 1)[0]
    assert "group: >-\n    deploy-${{ github.event.pull_request.number || github.ref }}" in head
    assert "cancel-in-progress: ${{ github.event_name == 'pull_request' }}" in head
    assert "refs/heads/main" not in head.split("cancel-in-progress:", 1)[1]


def test_the_stage_upload_waits_on_a_tip_check_made_right_before_it():
    steps = job_block(workflow("deploy.yml"), "preview").split("\n      - ")
    names = [step.split("\n", 1)[0] for step in steps]
    guard = next(i for i, name in enumerate(names) if "superseded" in name)
    upload = next(i for i, name in enumerate(names) if name == "name: Upload the stage Preview")
    assert guard == upload - 1, "the tip check must be the step right before the upload"
    text = steps[guard]
    assert "id: tip" in text
    assert "GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}" in text
    assert "GIT_SHA: ${{ github.sha }}" in text
    assert 'gh api "repos/${GH_REPO}/git/ref/heads/main" --jq .object.sha' in text
    assert 'python "$GITHUB_WORKSPACE/scripts/check_stage_tip.py" "$GIT_SHA" "$tip"' in text
    assert '>> "$GITHUB_OUTPUT"' in text
    assert "set -Eeuo pipefail" in text and "${{" not in text.split("run:", 1)[1]
    # Everything that follows the upload depends on it having happened.
    for step in steps[upload:]:
        assert "if: steps.tip.outputs.current == 'true'" in step, step.split("\n", 1)[0]


def test_the_stage_tip_check_says_current_only_for_the_tip_of_main(capsys):
    tip = load_script("check_stage_tip")
    a, b = "a" * 40, "b" * 40
    assert tip.is_current(a, a) is True
    assert tip.is_current(a, b) is False
    for bad in ("", "abc", "A" * 40, "g" * 40, "a" * 41, "refs/heads/main"):
        with pytest.raises(ValueError):
            tip.is_current(a, bad)
        with pytest.raises(ValueError):
            tip.is_current(bad, a)
    assert tip.main([a, a]) == 0
    assert capsys.readouterr().out == "current=true\n"
    assert tip.main([a, b]) == 0, "a superseded run is not a failure"
    captured = capsys.readouterr()
    assert captured.out == "current=false\n" and "::notice::" in captured.err
    assert tip.main([a, ""]) == 2, "an empty read of the tip is an error, not 'current'"
    assert capsys.readouterr().out == ""
    assert tip.main([a]) == 2


# --- the flow: typed branches into dev, dev into main, stage previews from main -------


def test_the_docs_describe_the_flow_with_no_stage_branch():
    docs = {
        name: (REPO / name).read_text(encoding="utf-8")
        for name in ("README.md", "SETUP.md", "AGENTS.md", "CONTRIBUTING.md")
    }
    for name, text in docs.items():
        assert "`stage` branch" not in text.replace("no `stage` branch", ""), name
        assert "dev` to `stage" not in text, name
        assert "stage` to `main" not in text, name
        assert "<type>/<kebab>" in text, name
    setup = docs["SETUP.md"]
    # The staging environment admits the main branch only, and Access guards the stage host.
    assert "`staging`: deployment branch policy **Selected branches**, `main` only" in setup
    assert "Cloudflare Access on `stage.orbit.szolotov.com`" in setup
    assert "git diff --quiet origin/dev...origin/main" in setup
    assert "a branch ruleset on `main` and one on `dev`" in setup
    assert "refs/tags/v*" in setup
    for name in ("README.md", "AGENTS.md", "CONTRIBUTING.md"):
        assert "https://stage.orbit.szolotov.com" in docs[name], name


def test_the_staging_environment_and_the_stage_host_are_named_consistently():
    deploy = workflow("deploy.yml")
    assert "stage_url=https://stage.orbit.szolotov.com" in deploy
    assert "name: staging" in job_block(deploy, "preview")
    assert "environment:" not in workflow("ci.yml")
