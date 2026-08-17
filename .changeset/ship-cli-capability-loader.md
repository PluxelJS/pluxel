---
'@pluxel/cli': minor
'@pluxel/create': minor
---

Ship project-local CLI delegation and project-anchored official capability loading.

Keep the published CLI thin by resolving optional owner packages from the invoking project only
when a command needs them, with explicit missing, incompatible, missing-subpath and import-failure
errors. Add the scoped `create-pluxel` initializer as a same-version wrapper around `pluxel new`,
and make generated app workspaces pin a local `@pluxel/cli` so global installs can delegate
predictably.
