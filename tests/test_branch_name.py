"""The branch-name gate: <type>/<kebab> for work, exemptions for the long-lived branches."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "check_branch_name.py"
spec = importlib.util.spec_from_file_location("check_branch_name", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


@pytest.mark.parametrize(
    "name",
    [
        "feat/contact-form",
        "fix/contact-form",
        "chore/bump-node-22.4",
        "docs/setup-notes",
        "ci/typed-branch-names",
        "test/branch-gate",
        "feat/a",
        "feat/2",
        "fix/404-page",
        "feat/site-from-template",
        "main",
        "dev",
        "dependabot/github_actions/actions-1",
        "dependabot/npm_and_yarn/deploy/wrangler-4.150.0",
    ],
)
def test_an_allowed_name_passes(name):
    assert gate.is_allowed(name)


@pytest.mark.parametrize(
    "name",
    [
        "",
        "feat/",
        "feat//x",
        "feat/-x",
        "feat/x-",
        "feat/a--b",
        "feat/a..1",
        "feat/a.b",
        "feat/.1",
        "feat/Contact",
        "feat/contact_form",
        "feat/contact/form",
        "feat/x y",
        "feat/x\n",
        "Feat/contact",
        "xfeat/contact",
        "feat-contact",
        "feature/contact-form",
        "release/v1.0.0",
        "feature-contact-form",
        "x/contact-form",
        "contact-form",
        "main2",
        "main/x",
        "dev/x",
        "stage",
        "stage-x",
        "stage/x",
        "dependabot",
        "dependabots/x",
        "feat/" + "a" * 120,
    ],
)
def test_any_other_name_fails(name):
    assert not gate.is_allowed(name)


@pytest.mark.parametrize(
    "name",
    [
        "claude/contact-form",
        "codex/contact-form",
        "copilot/contact-form",
        "ai/contact-form",
        "bot/contact-form",
        "Claude/contact-form",
        "claude/feat/contact-form",
        "ai/feat-contact-form",
    ],
)
def test_a_tool_named_prefix_is_rejected(name):
    assert gate.is_tool_named(name)
    assert not gate.is_allowed(name)


@pytest.mark.parametrize("name", ["feat/ai-search", "fix/claude-md", "docs/bot-policy"])
def test_a_tool_word_inside_a_typed_name_is_not_a_tool_prefix(name):
    assert not gate.is_tool_named(name)
    assert gate.is_allowed(name)


def test_there_is_no_stage_branch_and_no_untyped_prefix():
    assert frozenset({"main", "dev"}) == gate.LONG_LIVED
    assert not gate.is_allowed("stage")
    assert not gate.is_allowed("feature-contact-form")
    assert gate.TYPES == ("feat", "fix", "chore", "docs", "ci", "test")


def run(*args, env=None):
    import os

    merged = {k: v for k, v in os.environ.items() if k != "HEAD_REF"}
    merged.update(env or {})
    return subprocess.run(  # noqa: S603 - fixed interpreter and script path
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=merged,
        check=False,
    )


def test_the_script_reads_the_head_ref_from_the_environment():
    assert run(env={"HEAD_REF": "feat/contact-form"}).returncode == 0
    assert run(env={"HEAD_REF": "dev"}).returncode == 0
    assert run(env={"HEAD_REF": "dependabot/github_actions/actions-1"}).returncode == 0
    assert run(env={"HEAD_REF": "stage"}).returncode == 1


def test_a_bad_name_fails_with_a_message_that_says_what_to_do():
    result = run(env={"HEAD_REF": "feature/contact-form"})
    assert result.returncode == 1
    assert "<type>/<kebab>" in result.stderr
    assert "feat, fix, chore, docs, ci or test" in result.stderr
    assert "feature/contact-form" in result.stderr
    assert result.stdout.startswith("::error")


def test_a_tool_named_branch_fails_with_its_own_message():
    result = run(env={"HEAD_REF": "claude/contact-form"})
    assert result.returncode == 1
    assert "tool-named prefix" in result.stderr
    assert "tooling attribution" in result.stderr
    assert "claude/contact-form" in result.stderr
    assert result.stdout.startswith("::error")


def test_no_head_ref_means_not_a_pull_request_and_passes():
    assert run().returncode == 0


def test_the_first_argument_wins_and_two_arguments_are_a_usage_error():
    assert run("feat/x", env={"HEAD_REF": "bad/name"}).returncode == 0
    assert run("feat/x", "feat/y").returncode == 2


def test_a_hostile_name_cannot_forge_workflow_commands():
    name = "feat/x\n::error::forged%0A"
    result = run(name)
    assert result.returncode == 1
    assert "\n::error::forged" not in result.stdout.replace("::error title=Branch name::", "", 1)
    assert "%250A" in result.stdout
