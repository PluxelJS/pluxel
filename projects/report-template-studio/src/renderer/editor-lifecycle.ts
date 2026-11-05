import type { ContentController } from '@worksplit/react'
import type { WorkspaceController } from './workspace'

/** Closing a view saves its shared resource; discarding is an explicit resource action. */
export function editorLifecycle(
	workspace: WorkspaceController,
	path: string,
	kind: 'file' | 'form',
): ContentController {
	const input = () => (kind === 'form' ? workspace.documents.get(path) : workspace.inputOwner(path))
	const isDirty = () =>
		Boolean(workspace.files.get(path)?.dirty || input()?.inputDirty || input()?.inputConflict)
	const basis = () =>
		JSON.stringify([
			workspace.project.id,
			workspace.project.root,
			path,
			kind,
			workspace.files.get(path)?.token ?? 0,
			workspace.files.get(path)?.external ?? 0,
			!!workspace.files.get(path)?.missing,
			input()?.inputToken ?? 0,
			input()?.inputEpoch ?? 0,
			!!input()?.bodyLocked,
		])
	const getState = () => ({
		hasUnsavedChanges: isDirty(),
		token: JSON.stringify([basis(), !!workspace.files.get(path)?.saving, !!input()?.inputSaving]),
	})
	const save = async () => {
		await Promise.all([
			workspace.save(path),
			...(kind === 'form' ? [workspace.saveInput(path)] : []),
		])
	}
	return {
		leave: {
			getState,
			async decide(request) {
				const reviewed = basis()
				await save()
				if (
					request.signal.aborted ||
					reviewed !== basis() ||
					isDirty() ||
					workspace.files.get(path)?.saving ||
					input()?.bodyLocked ||
					input()?.inputSaving
				)
					return { decision: 'deny' }
				// Approval precedes native loader completion. Keep this shared draft stable
				// until this particular request ends; overlapping requests hold separate leases.
				request.defer(workspace.pauseEditing(path))
				return { decision: 'allow', token: getState().token }
			},
		},
		save,
	}
}
