---
packages:
  '@pluxel/workbench': minor
  '@pluxel/services': minor
---

## Let users pin declared applications to the sidebar

Workbench now lets users pin and remove declared route and tab entries from the
main sidebar. Preferences are part of the native workspace snapshot and preserve
canonical Plugin identities, including forks. Unavailable entries stay visible
without being redirected to another Plugin.

Host assemblies can supply `initialShortcuts` through `workbenchService()` or
`servicesPreset()`. Defaults only initialize a workspace without preferences;
an explicitly emptied list stays empty. Plugins declare discoverable entries
and do not decide their own root placement. Global layouts now include tab
entries alongside routes so the application directory can discover both.

Native container configuration can now be updated through Worksplit dispatch
and restored from its snapshot, while protected content metadata stays guarded.
