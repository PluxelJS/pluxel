import type { WorkbenchContentLifecycle } from '@worksplit/react'
import type { WorkspaceController } from './workspace'

/** Closing a view may save a shared resource. Discarding it is an explicit resource action. */
export function editorLifecycle(
	workspace: WorkspaceController,
	path: string,
	kind: 'file' | 'form',
): WorkbenchContentLifecycle {
	const input = () => (kind === 'form' ? workspace.documents.get(path) : workspace.inputOwner(path))
	const isDirty = () =>
		Boolean(workspace.files.get(path)?.dirty || input()?.inputDirty || input()?.inputConflict)
	const save = async () => {
		await Promise.all([
			workspace.save(path),
			...(kind === 'form' ? [workspace.saveInput(path)] : []),
		])
	}
	return {
		isDirty,
		getCloseRevision: () =>
			`${workspace.files.get(path)?.token ?? 0}:${input()?.inputToken ?? 0}:${input()?.inputEpoch ?? 0}:${!!input()?.bodyLocked}:${!!input()?.inputSaving}`,
		beforeLeave: async () => {
			await save()
			return !isDirty() && !input()?.bodyLocked && !input()?.inputSaving
		},
		save,
	}
}
