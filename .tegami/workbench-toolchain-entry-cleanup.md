---
packages:
  '@pluxel/workbench': major
  '@pluxel/rolldown': major
---

## Keep implementation modules private

Remove unused Workbench `/paths`, `/internal/shell` and `/internal/definition` exports and the unused
Rolldown `/internal/static-config-environment-vite` adapter. Package-local white-box tests import
source modules directly. The generated browser React Bridge ABI remains isolated at
`@pluxel/workbench/internal/react`.

Workbench owner publication now captures the owner directly in the frozen `publish()` capability, removing the intermediate `WorkbenchService` wrapper while preserving PluginPart rejection and backend admission. Remove the unused `createWorkbenchBackend` factory and `WorkbenchBackendFactory` type; custom internal test assembly still injects a backend through the shared service installation path. Shell asset paths are owned locally by Workbench.
