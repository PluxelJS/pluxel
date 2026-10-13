---
packages:
  '@pluxel/workbench': minor
---

# Restore direct navigation and contextual plugin tools

Restore an official activity rail with icons by default and an optional text mode. Separate business applications at `/apps` from plugin management at `/plugins`. The management workspace shows its plugin directory; business application sidebars show only the current owner's contributed panels and take no space when no left panel exists. Hide the redundant native border strip when navigation is its only tab, and show it again when documents are docked there. Application discovery respects explicit route navigation declarations and highlights the exact active entry.

Use each tab container's `+` action to choose an entry and create an independent document. Ordinary navigation reuses an existing document, and entry lists no longer show a separate duplicate button for every item. Global search remains available for discovery.

Use compact single-line navigation with status dots, explicit problem labels, collapsible counted groups, and search that reveals matches without overwriting collapse preferences. Keep search and management on one row, and collapse the default sidebar on narrow screens.

Keep configuration and plugin pages in the document area, with plugin information initially hidden on the right. Open plugin-scoped logs on demand in a native TabSet below the central documents, without spanning the sidebars. The header toggle hides logs while preserving their native node and return position; showing logs restores that position when available. Explicitly closing the log tab removes only that tool. Both tools follow the active document's canonical plugin, including forks and declared page owners. Hidden tools release their reads and log subscriptions, including when another container is maximized, without discarding document drafts.

Center independent left, right and bottom visibility controls in the header and restore the selected tool when showing a sidebar again. Persist the activity rail display mode with the native layout. Use layout storage version 4 and start from the new default layout instead of restoring older layouts; unsaved drafts are not migrated.

Add `workbench.panel(region, { label, icon?, order? })` for Content, View and placed Attachment contributions to the active plugin’s left, right or bottom tools. Panels have plugin-owner context, not the active document’s entity or route parameters. Entity editing and unsaved configuration remain in independent central documents. Panels share existing publication admission and per-open cleanup, switch without changing the document URL, and release resources when hidden or when the plugin changes. The ReportStudio example demonstrates static guidance and live status/artifact panels through existing domain snapshots and subscriptions.
