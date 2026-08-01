---
'@pluxel/runtime': minor
---

Make Workbench plugin catalog classification host-owned and closed: hosts can register fixed plugin
and package-prefix groups, dynamically installed third-party plugins automatically group by exact
package name, and users can reorder or reassign plugins only among registered groups. Persist user
layout differences in a Workbench-owned namespace and migrate only legacy memberships allowed by
the host.
