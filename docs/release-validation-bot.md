# Release validation bot

The **Release validation bot** workflow runs four times daily from the default branch,
or by manual dispatch from main/dev. It refreshes all registered vendor releases and
security notes together using the existing snapshot scripts. The read-only weekly Data
check remains independent. Changes in refresh/check timestamps alone do not create a PR.

The refresh job has no write permission, checks the result schema and runs Node tests.
A separate proposal job copies only the generated data files and optional result,
verifies the dev commit has not moved, and opens a reviewable PR into dev. No force push,
no merge, no stage or production deployment. One open proposal at a time; a closed
identical proposal is not recreated. The existing owner review and promotion process
is unchanged.

In ops-toolbox, a new stable RouterOS candidate is tested under CHR and emits a JSON
evidence file with the bump PR. Once reviewed and merged to its dev branch, Orbit reads
that version-specific file from an immutable commit, verifies the matching upstream
workflow run and successful CHR step through the public GitHub API, and records WARN
with physical hardware explicitly UNTESTED. Existing manually reviewed results are
never overwritten. Missing, invalid or unavailable evidence does not imply firmware
compatibility. This path does not require a cross-repository secret.

Enable repository Actions permission to create pull requests if not already enabled.
The bot uses the built-in repository token. Its generated PR may require the owner
to approve PR-event workflows; the bot also dispatches CI and Security on the branch.
Those branch checks do not replace PR merge-result checks or the deployment dry run.
A failed refresh opens a deduplicated issue; investigate, close it and retry manually.
The workflow becomes scheduled only after it reaches the default branch.

A later, separately approved GitHub App integration can remove the manual workflow
approval where policy permits. No automatic merges or physical router upgrades.
