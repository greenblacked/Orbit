"""The branch-name gate: fb-<kebab> for work, exemptions for the long-lived branches."""

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
        "fb-contact-form",
        "fb-a",
        "fb-2",
        "fb-fix-404-page",
        "fb-a--b",
        "main",
        "stage",
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
        "fb-",
        "fb--x",
        "fb-Contact",
        "fb-contact_form",
        "fb-contact/form",
        "fb-x y",
        "fb-x\n",
        "feature/contact-form",
        "fix/contact-form",
        "contact-form",
        "FB-contact",
        "xfb-contact",
        "main2",
        "dev/x",
        "stage-x",
        "dependabot",
        "dependabots/x",
        "fb-" + "a" * 120,
    ],
)
def test_any_other_name_fails(name):
    assert not gate.is_allowed(name)


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
    assert run(env={"HEAD_REF": "fb-contact-form"}).returncode == 0
    assert run(env={"HEAD_REF": "dev"}).returncode == 0
    assert run(env={"HEAD_REF": "stage"}).returncode == 0


def test_a_bad_name_fails_with_a_message_that_says_what_to_do():
    result = run(env={"HEAD_REF": "feature/contact-form"})
    assert result.returncode == 1
    assert "fb-<kebab>" in result.stderr
    assert "feature/contact-form" in result.stderr
    assert result.stdout.startswith("::error")


def test_no_head_ref_means_not_a_pull_request_and_passes():
    assert run().returncode == 0


def test_the_first_argument_wins_and_two_arguments_are_a_usage_error():
    assert run("fb-x", env={"HEAD_REF": "bad/name"}).returncode == 0
    assert run("fb-x", "fb-y").returncode == 2


def test_a_hostile_name_cannot_forge_workflow_commands():
    name = "fb-x\n::error::forged%0A"
    result = run(name)
    assert result.returncode == 1
    assert "\n::error::forged" not in result.stdout.replace("::error title=Branch name::", "", 1)
    assert "%250A" in result.stdout
