# Market Service Design

## Responsibilities
- Provide RPC-facing market queries (`listLoadIssues`, `listPackageInventory`).
- Normalize mutation inputs and execute package operations via `PackageService`.
- Serialize results into stable `PackageMutationResult` / `PackageBatchMutationResult` payloads.

## Mutation Pipeline
1. Validate action and spec list.
2. Parse specs with `toServiceSpecifierInput` + `normalizeSpecifier`.
3. Run the action handler (install/uninstall/remove/reinstall/reload/retry).
4. Convert service results into mutation payloads.

## Error Strategy
- Invalid specs return per-item failures with `invalid_spec` code.
- Batch-level errors set `error` and force `ok = false`.
- Per-item errors include normalized spec to keep UI mapping stable.

## Performance Notes
- `install` batches package manager operations and limits concurrent loads.
- Other actions lean on `PackageService` locks to avoid redundant work.
