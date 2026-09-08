# CLA Automation

Pluxel uses a repository-local CLA check instead of a hosted CLA application.

The source of truth is:

- `CLA.md`: the Contributor License Agreement text
- the protected base branch `.cla/signatures.json`: reusable account acceptance records
- authenticated PR comments: acceptance evidence for the current contribution
- `scripts/check-cla.mjs`: the portable checker used by CI

## Signing

Contributors accept the CLA by commenting on their pull request:

```text
/approve-cla
```

Post the command after the workflow's CLA prompt. The prompt links to the exact
protected policy revision and includes its SHA-256 hash. CI verifies that the
comment belongs to the PR author, records an audit receipt on the PR, and updates
the `CLA` commit status directly. Forks use the same flow; no branch write or new
commit is required. Current GitHub records use `host: "github.com"`.

Each receipt preserves the precise UTC acceptance time, repository, pull request,
accepted head commit, public approval comment URL, and CLA content hash. These
fields bind an account-level approval to a concrete contribution without placing
private legal identity data in the repository. Employment authorization or other
non-public evidence belongs in access-controlled legal records.

An existing account acceptance in the protected registry can also satisfy the
check. New comment-based approvals apply to that PR, including later commits;
contributors sign again on their next PR unless a maintainer has preserved the
verified acceptance in the protected registry. PR changes to that registry do
not establish acceptance. The original author comment remains the evidence;
editing it away or deleting it causes the check to require a new comment.

The `claSha256` value must match the protected `CLA.md` content:

```sh
pnpm cla:hash
```

Changing `CLA.md` intentionally invalidates older signature hashes. Contributors
must approve the new revision before their next pull request can pass.

The current CLA includes electronic acceptance and reasonable license-enforcement
cooperation. It does not assign contributor copyright. The named legal steward,
governing law, and whether the grant provides enforcement standing in relevant
jurisdictions still require review by qualified counsel before relying on the CLA
for litigation.

## GitHub

`.github/workflows/cla.yml` runs on pull requests and `/approve-cla` comments;
comment edits and deletions also recheck the evidence. It checks out only the
trusted base/default branch script, without credentials, and never checks out
or executes PR head files. The script obtains the current PR through the GitHub
API and reads both policy and registry at that PR's single pinned base SHA.

Only a prompt authored by GitHub Actions' bot can identify the current policy.
The author's approval must follow that prompt. Comments are read across all
pages; contributor-supplied markers and other users' approvals are not evidence.
Verification and comment handling share the same path and serialize per PR.

The workflow token has contents/pull-request read access, issue-comment write
access, and commit-status write access. It cannot write signature commits.
Both PR and approval events publish the `CLA` status to the head SHA obtained
from the PR API, so approval can replace a failing status without waiting for
another workflow trigger. A run pinned to an older head cannot mark a newer
head successful. Missing acceptance produces a failing `CLA` status and an
explanatory log; an API or verification error also fails the workflow job.

## Codeberg, Forgejo, and Woodpecker

The signature file format is platform-neutral. A Codeberg or Forgejo setup can
keep the same flow: listen for `/approve-cla`, write the corresponding entry to
`.cla/signatures.json`, then run:

```sh
node scripts/check-cla.mjs --host codeberg.org --user "$PR_AUTHOR"
```

Use the CI variable that contains the pull request author's Codeberg username.
Woodpecker provides repository and pull request environment variables, but the
exact author variable depends on the configured host and Woodpecker version; set
`CLA_USER` explicitly if the built-in variable is not the account username.

For Forgejo Actions, place an equivalent workflow under `.forgejo/workflows/` and
run the same Node command. Forgejo Actions uses GitHub-like workflow files, but
it is not guaranteed to be fully GitHub Actions compatible.

## Branch Protection

Require the `CLA` commit status before merging pull requests. The workflow job
is named `Update CLA status`; that job's success means verification ran, not
that acceptance exists. When configuring branch protection, select the `CLA`
status rather than the workflow job, and remove any requirement for the previous
workflow check with the same name. Keep the normal CI checks required as well.
