# Release validation bot

The **Release validation bot** workflow runs daily at 06:47 UTC from the default branch,
or by manual dispatch from main/dev. It refreshes all registered vendor releases and
security notes together using the existing snapshot scripts. The read-only weekly Data
check remains independent. Changes in refresh/check timestamps alone do not create a PR.

The refresh job has no write permission, checks the result schema and runs Node tests.
A separate job pushes a candidate branch containing only the generated data files and
optional result. The bot dispatches CI and Security, waits for both runs to pass on the
exact candidate commit, rechecks the candidate and `dev` refs, and opens a PR into `dev`.
A failed, cancelled or mismatched run leaves the candidate branch available for retry.
The bot never force-pushes, merges or deploys. It opens one proposal at a time and
does not recreate an identical closed proposal. The existing owner review and promotion process
is unchanged.

In ops-toolbox, a new stable RouterOS candidate is tested under CHR and emits a JSON
evidence file with the bump PR. Once reviewed and merged to its dev branch, Orbit reads
that version-specific file from an immutable commit, verifies the matching upstream
workflow run and successful CHR step through the public GitHub API, and records WARN
with physical hardware explicitly UNTESTED. Existing manually reviewed results are
never overwritten. Missing, invalid or unavailable evidence does not imply firmware
compatibility. This path does not require a cross-repository secret.

Before rollout, enable **Allow GitHub Actions to create and approve pull requests**
in the repository's Actions settings. The organization policy must allow it too.
The bot uses the built-in repository token. When that token can read the setting,
a disabled setting stops the proposal before the push. When GitHub limits access to
the setting, the PR creation request determines whether the token can open a PR.
If creation fails after the push, a later run can resume the branch after checking
that its single commit has the same dev parent and matches the regenerated candidate.
The comparison ignores snapshot timestamp churn and checks the full tree for
unexpected paths and file-mode changes. Its generated PR may require the owner
to approve PR-event workflows. Those merge-result checks and the deployment dry run
still apply after the PR opens.
A failed refresh opens a deduplicated issue; investigate, close it and retry manually.
The workflow becomes scheduled only after it reaches the default branch.

A later, separately approved GitHub App integration can remove the manual workflow
approval where policy permits. No automatic merges or physical router upgrades.
