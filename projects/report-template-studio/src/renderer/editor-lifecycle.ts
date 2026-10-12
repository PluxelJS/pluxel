import type { WorkbenchContentLifecycle } from '@worksplit/react'
import type { WorkspaceController } from './workspace'

/** Closing a view may save a shared resource. Discarding it is an explicit resource action. */
export function editorLifecycle(
	workspace: WorkspaceController,
	path: string,
	kind: 'file' | 'form',
): WorkbenchContentLifecycle {
	const isDirty = () =>
		Boolean(
			workspace.files.get(path)?.dirty ||
			(kind === 'form' && workspace.documents.get(path)?.inputDirty),
		)
	const save = async () => {
		await Promise.all([
			workspace.save(path),
			...(kind === 'form' ? [workspace.saveInput(path)] : []),
		])
	}
	return {
		isDirty,
		getCloseRevision: () =>
			`${workspace.files.get(path)?.token ?? 0}:${kind === 'form' ? (workspace.documents.get(path)?.inputToken ?? 0) : ''}`,
		beforeLeave: async () => {
			await save()
			return !isDirty()
		},
		save,
	}
}
