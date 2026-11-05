---
packages:
  '@pluxel/workbench': minor
---

## Move Workbench to native Worksplit sessions

Workbench now uses the current Worksplit session and content controller contracts,
with guarded navigation and workspace exit, native default menus, independent
copies and cleanup receipts. Configuration drafts survive refused navigation and
new edits made during a save; pending writes also prevent departure.
Native copies use an automatic title and a fresh draft; manual names remain with
the original tab across navigation.

Workspace snapshots use Worksplit v2. Existing incompatible layouts remain intact
until the user explicitly resets them; layout recovery does not remove business
data. Source development and builds check the exact native dependencies and full
Worksplit patch set before loading the host.
