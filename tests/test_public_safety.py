"""Nothing that should stay off a public repository is tracked.

Scans every tracked text file for home-directory paths, secret-like strings and tooling
attribution (a generated-by footer, a co-author trailer for a tool, a session link). The
patterns are deliberately conservative: a hit is a reason to look, not noise to waive.
Standard library only.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest
from helpers import REPO

SELF = Path(__file__).resolve()

HOME_PATHS = {
    "a Unix home directory": re.compile(r"/home/[A-Za-z0-9_.-]+/"),
    "a macOS home directory": re.compile(r"/Users/[A-Za-z0-9_.-]+/"),
    "a Windows home directory": re.compile(r"[A-Za-z]:\\Users\\[A-Za-z0-9_. -]+\\"),
    "a dotfile under the home shorthand": re.compile(r"~/\.(?:ssh|aws|config|claude|npmrc|netrc)"),
}

SECRETS = {
    "a private key block": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "a GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "a GitHub fine-grained token": re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b"),
    "an AWS access key id": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "a Slack token": re.compile(r"\bxox[abeoprs]-[A-Za-z0-9-]{10,}"),
    "an API key with a vendor prefix": re.compile(r"\bsk-[A-Za-z0-9_-]{32,}"),
    "a credential assigned a literal value": re.compile(
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd)\b[\"']?\s*[:=]\s*"
        r"[\"'][A-Za-z0-9/+_=.-]{24,}[\"']"
    ),
    "credentials inside a URL": re.compile(
        r"https?://[A-Za-z][^/\s:@]*:[^/\s:@]{6,}@[A-Za-z0-9.-]+"
    ),
}

ATTRIBUTION = {
    "a generated-by footer": re.compile(
        r"(?i)\bgenerated (?:with|by)\s+\[?(?:claude|codex|copilot|chatgpt|gpt|gemini|cursor)\b"
    ),
    "a co-author trailer": re.compile(r"(?im)^\s*co-authored-by:\s*.+<[^>\s]+@[^>\s]+>"),
    "a coding-session link": re.compile(r"(?i)\bclaude\.ai/code\b"),
    "a tool-credit line": re.compile(
        r"(?i)\b(?:written|created|authored) (?:with|by) (?:claude|codex|copilot|chatgpt)\b"
    ),
}

CHECKS = {**HOME_PATHS, **SECRETS, **ATTRIBUTION}


def tracked_files() -> list[Path]:
    git = shutil.which("git")
    if git is None or not (REPO / ".git").exists():
        pytest.skip("not a git checkout, so there is no list of tracked files")
    out = subprocess.run(  # noqa: S603 - resolved git binary, fixed arguments
        [git, "-C", str(REPO), "ls-files", "-z"], check=True, capture_output=True
    ).stdout
    return [REPO / name for name in out.decode("utf-8").split("\0") if name]


def read_text(path: Path) -> str | None:
    """The file's text, or None for a binary file, a symlink or a file that is gone."""
    if path.is_symlink() or not path.is_file():
        return None
    data = path.read_bytes()
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def findings() -> list[str]:
    found = []
    for path in tracked_files():
        if path.resolve() == SELF:
            continue
        text = read_text(path)
        if text is None:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            for label, pattern in CHECKS.items():
                if pattern.search(line):
                    found.append(f"{path.relative_to(REPO)}:{number}: {label}")
    return found


def test_the_patterns_catch_what_they_are_for():
    assert HOME_PATHS["a Unix home directory"].search("cd /home/someone/work")
    assert HOME_PATHS["a macOS home directory"].search("/Users/someone/work")
    assert not HOME_PATHS["a Unix home directory"].search("/home/[a-z]")
    assert SECRETS["a GitHub token"].search("ghp_" + "a" * 36)
    assert SECRETS["a private key block"].search("-----BEGIN " + "RSA PRIVATE KEY-----")
    assert SECRETS["a credential assigned a literal value"].search('token = "' + "a" * 30 + '"')
    assert not SECRETS["a credential assigned a literal value"].search("token: ${{ secrets.X }}")
    assert ATTRIBUTION["a co-author trailer"].search("Co-" + "Authored-By: Name <name@example.com>")
    assert ATTRIBUTION["a generated-by footer"].search("Generated " + "with Claude")
    assert not ATTRIBUTION["a generated-by footer"].search("no generated-by footers")


def test_no_tracked_file_carries_a_private_path_a_secret_or_a_tool_credit():
    found = findings()
    assert not found, "public-safety findings:\n" + "\n".join(found)


def test_no_environment_or_key_file_is_tracked():
    names = [p.relative_to(REPO).as_posix() for p in tracked_files()]
    pattern = re.compile(r"(^|/)(\.env(\..+)?|\.dev\.vars|id_[a-z0-9]+|.*\.(pem|p12|pfx|key))$")
    bad = [n for n in names if pattern.search(n) and not n.endswith(".env.example")]
    assert not bad, bad
