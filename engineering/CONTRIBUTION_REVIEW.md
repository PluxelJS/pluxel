# Contribution review

Contribution acceptance is a manual merge prerequisite owned by the maintainer.
The agreement remains in [`CLA.md`](../CLA.md), and the contributor-facing process
is documented in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Before merging

- Verify that each human contributor personally accepted the agreement for their
  contributions, using the PR template checkbox or an explicit comment linking
  to the agreement. Do not check the box on someone else's behalf.
- Review the description, comments, and available edit history when authorship or
  acceptance is unclear. Do not merge without clear acceptance, or while it is
  disputed. If the agreement changes during review, request fresh confirmation
  linking to the revised agreement.
- Review bot-only dependency updates such as Dependabot PRs manually; bots are not
  asked to sign. Human contributions included in those PRs still need acceptance.
- Run the applicable code checks and review the proposed changes as usual.

## Records and migration

GitHub holds the PR description, comments, and available edit history. The PR
template does not enforce a required checkbox. This repository has no CLA
workflow, approval command, signature database, or generated acceptance receipts.
Existing PRs need the checkbox added by their contributor or an explicit
acceptance comment; changing the default template does not update existing PRs.
Historical approval comments remain in GitHub and can be reviewed manually.

When adopting this process, remove only any obsolete `CLA` required check from
branch protection or rulesets, retaining the code checks. Old failed CLA runs and
commit statuses remain historical records; do not publish artificial successful
CLA statuses. Replacing the workflow does not retroactively change those results.

GitHub's [edit history documentation](https://docs.github.com/en/communities/moderating-comments-and-conversations/tracking-changes-in-a-comment)
describes limits and deletion of history. This process is not an immutable audit
archive and does not establish enforceability in every jurisdiction.

## Actions maintenance

Workflows follow supported major tags (`@v7`, `@v6`, `@v9`, `@v4`) so compatible
updates are picked up without SHA-only update PRs. Dependabot continues to check
GitHub Actions weekly for new major versions. The runner toolchain remains pinned
in `mise.toml` for reproducible local and CI installs.
