# CLA Automation

Pluxel uses a repository-local CLA check instead of a hosted CLA application.

The source of truth is:

- `CLA.md`: the Contributor License Agreement text
- `.cla/signatures.json`: code hosting account acceptance records
- `scripts/check-cla.mjs`: the portable checker used by CI

## Signing

Contributors accept the CLA by commenting on their pull request:

```text
/approve-cla
```

CI records that approval in `.cla/signatures.json` on the pull request branch.
Pluxel is currently hosted on GitHub, so current pull requests use
`host: "github.com"`.

The `claSha256` value must match the current `CLA.md` content:

```sh
pnpm cla:hash
```

Changing `CLA.md` intentionally invalidates older signature hashes. Contributors
must approve the new revision before their next pull request can pass.

## GitHub

`.github/workflows/cla.yml` runs on pull requests and `/approve-cla` comments.
The pull request check reads `.cla/signatures.json` from the pull request branch,
then runs the protected base branch copy of `scripts/check-cla.mjs`.

This keeps the check from trusting a modified checker script in the pull request.

When the pull request author comments `/approve-cla`, the workflow updates
`.cla/signatures.json` on the pull request branch. Same-repository pull requests
can be updated automatically. Fork pull requests may require a maintainer to
record the same approval because the repository token may not be able to push to
the contributor fork.

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

Require the `CLA` status check before merging pull requests. Keep the normal CI
checks required as well.
