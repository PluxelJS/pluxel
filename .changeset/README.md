# Changesets

Pluxel uses independent semantic versions for its public packages. This keeps the core/runtime
release train separate from packages such as `valibot-form` and allows newer packages to mature at
their own pace.

Add a changeset to every pull request with a user-visible package change:

```sh
pnpm changeset
```

Patch releases should list only the packages whose public behavior changed. When an internal
`workspace:*` dependency requires a downstream release, Changesets updates that dependency and
package version during `pnpm release:version`.
