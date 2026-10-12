import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
	useWorkbenchContent,
	useWorkbenchContentLifecycle,
	type WorkbenchContentLifecycle,
} from '@worksplit/react'
import { openConfirmModal } from '@mantine/modals'
import { useWorkspaceSession } from './workspaceContext'

/** Business facts belong to this content instance, independent of its native docking location. */
export class WorkbenchDocumentState {
	editor?: WorkbenchContentLifecycle
	remoteDirty = false
	private revisionOwner?: WorkbenchContentLifecycle
	private ownerRevision = 0
	readCloseRevision = () => {
		if (this.revisionOwner !== this.editor) {
			this.revisionOwner = this.editor
			this.ownerRevision++
		}
		const revision = this.editor?.getCloseRevision?.()
		return `${this.ownerRevision}:${typeof revision}:${revision}`
	}
	private readonly resources = new Set<() => void | Promise<void>>()
	isDirty = () => this.remoteDirty || Boolean(this.editor?.isDirty?.())
	registerResource(dispose: () => void | Promise<void>) {
		this.resources.add(dispose)
		return () => {
			this.resources.delete(dispose)
		}
	}
	async dispose() {
		const results = await Promise.allSettled(
			[...this.resources].map(async (dispose) => {
				await dispose()
			}),
		)
		this.resources.clear()
		const failures = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)
		if (failures.length > 0) throw new AggregateError(failures, '文档资源释放失败')
	}

	async beforeLeave(): Promise<boolean> {
		if (!this.isDirty()) return true
		const editor = this.editor
		const revision = editor?.getCloseRevision?.()
		const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
			openConfirmModal({
				title: '此文档有未保存的更改',
				children: editor?.save
					? '保存成功后继续，或取消并保留输入。'
					: '继续会放弃此文档的未保存更改。',
				labels: {
					confirm: editor?.save ? '保存并继续' : '放弃更改并继续',
					cancel: '保留文档',
				},
				onConfirm: () => resolve(editor?.save ? 'save' : 'discard'),
				onCancel: () => resolve('cancel'),
				onClose: () => resolve('cancel'),
			})
		})
		if (choice === 'cancel') return false
		if (choice === 'save') {
			await editor?.save?.()
			return this.editor === editor && !this.isDirty()
		}
		return this.editor === editor && revision === editor?.getCloseRevision?.()
	}
}

const DocumentContext = createContext<{ id: string; state: WorkbenchDocumentState } | null>(null)
export function useOptionalWorkbenchDocument() {
	return useContext(DocumentContext)
}

export function WorkbenchDocumentRoot({ children }: { children: ReactNode }) {
	const content = useWorkbenchContent()
	const session = useWorkspaceSession()
	const [state] = useState(() => new WorkbenchDocumentState())
	const lifecycle = useMemo<WorkbenchContentLifecycle>(
		() => ({
			isDirty: state.isDirty,
			get getCloseRevision() {
				return state.remoteDirty || !state.editor?.getCloseRevision
					? undefined
					: state.readCloseRevision
			},
			beforeLeave: async (reason, context) => {
				// Search/hash changes preserve this content's editable resource.
				if (reason === 'navigate' && context.from && context.to) {
					const from = new URL(context.from, 'http://workbench.local')
					const to = new URL(context.to, from)
					if (
						from.pathname === to.pathname &&
						from.searchParams.get('entry') === to.searchParams.get('entry')
					)
						return true
				}
				return state.beforeLeave()
			},
			save: async () => {
				await state.editor?.save?.()
			},
			dispose: () => state.dispose(),
		}),
		[state],
	)
	useWorkbenchContentLifecycle(lifecycle)
	useEffect(() => {
		session.documents.set(content.id, state)
		return () => {
			session.documents.delete(content.id)
		}
	}, [content.id, session, state])
	const value = useMemo(() => ({ id: content.id, state }), [content.id, state])
	return <DocumentContext.Provider value={value}>{children}</DocumentContext.Provider>
}
