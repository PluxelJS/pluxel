import { createWorkbench, type NavigationResult } from '@worksplit/react'
import { Actions, DockLocation } from 'flexlayout-react'
import type { ProjectSummary } from '../shared/contracts'
import { api } from './api'
import { AssistantPanel } from './assistant'
import { WorkspaceController, useWorkspaceState } from './workspace'
import { assistantTab, createStudioLayout, documentTarget, findTool } from './workbench-layout'
import { createStudioRouter, studioDocument, type StudioDocument } from './workbench-routes'

/** One project owns business state and one Worksplit instance. Shell components borrow them. */
export class StudioSession {
	readonly workspace: WorkspaceController
	readonly workbench
	private starting?: Promise<void>
	private disposing?: Promise<void>
	private closed = false
	private disconnectSource: () => void

	constructor(readonly project: ProjectSummary) {
		const workspace = (this.workspace = new WorkspaceController(project))
		this.workbench = createWorkbench({
			workspaceId: project.id,
			home: '/',
			homeMode: 'empty',
			createRouter: createStudioRouter,
			layout: createStudioLayout(),
			tools: [{ id: 'assistant', render: () => <AssistantTool workspace={workspace} /> }],
			onIssue: ({ code, id, error }) =>
				this.report(
					new Error(`${code}${id ? ` (${id})` : ''}: ${String(error)}`, { cause: error }),
				),
		})
		this.disconnectSource = workspace.connectSourceNavigation(async (path) => {
			const result = await this.open('file', path)
			return result.status === 'committed'
		})
	}

	report(cause: unknown) {
		this.workspace.error = cause instanceof Error ? cause.message : String(cause)
		this.workspace.emit()
	}

	start(): Promise<void> {
		return (this.starting ??= (async () => {
			if (this.closed) throw new Error('项目已关闭')
			const result = await this.workbench.start('/')
			if (result.status === 'failed') throw result.error
			if (this.closed || (result.status !== 'empty' && result.status !== 'committed')) return
			this.workspace.start()
			if (!(await this.workspace.refresh())) return
			const first = this.workspace.tree?.documents[0]
			if (!this.closed && first) await this.openReport(first.entry)
		})())
	}

	dispose(): Promise<void> {
		if (this.disposing) return this.disposing
		this.closed = true
		this.disconnectSource()
		return (this.disposing = (async () => {
			try {
				const errors = await this.workbench.dispose()
				if (errors.length > 0)
					throw new AggregateError(errors, '项目内容已关闭，但部分资源释放失败')
			} finally {
				this.workspace.dispose()
			}
		})())
	}

	async open(
		kind: StudioDocument['kind'],
		path: string,
		options: { newInstance?: boolean; background?: boolean } = {},
	): Promise<NavigationResult> {
		const { workbench, workspace } = this
		const target = documentTarget(
			kind,
			workbench.getLayout(),
			workbench.getDocuments(),
			workbench.getEditingContext().activeGroupId,
		)
		const active = workbench.getActiveDocument()
		const placement = {
			...target,
			...options,
			preserveFocus:
				!options.background &&
				kind === 'preview' &&
				Boolean(active && (target.location !== undefined || target.target !== active.containerId)),
		}
		const result =
			kind === 'file'
				? await workbench.open({ to: '/file', search: { path } }, placement)
				: kind === 'form'
					? await workbench.open({ to: '/form', search: { entry: path } }, placement)
					: await workbench.open({ to: '/preview', search: { entry: path } }, placement)
		if (result.status === 'failed') throw result.error
		if (result.status === 'committed') {
			const renamed = await workbench.dispatch(
				Actions.renameTab(
					result.document.id,
					`${kind === 'preview' ? '预览 · ' : ''}${kind === 'file' ? path.split('/').at(-1) : (workspace.documents.get(path)?.result?.name ?? path.split('/').at(-1)?.replace(/\.ts$/, ''))}`,
				),
			)
			if (renamed.status !== 'applied') {
				if (!workbench.getDocument(result.document.id)) return { status: 'superseded' }
				throw new Error('文档已打开，但标签标题未能更新')
			}
		}
		return result
	}

	async openReport(path: string): Promise<void> {
		const result = await this.open('form', path)
		if (result.status !== 'committed') return
		this.workspace.preferPreview(path)
		await this.open('preview', path)
	}

	async showAssistant(dock?: 'bottom' | 'right') {
		const { workbench } = this
		if (!dock && workbench.activate('assistant')) return
		const layout = workbench.getLayout()
		const destination = dock ?? 'bottom'
		if (!layout.borders?.some((border) => border.location === destination))
			throw new Error(`当前布局没有 ${destination} 停靠区`)
		const action = findTool(layout, 'assistant')
			? Actions.moveNode('assistant', `border_${destination}`, DockLocation.CENTER, -1, true)
			: Actions.addTab({ ...assistantTab }, `border_${destination}`, DockLocation.CENTER, -1, true)
		const result = await workbench.dispatch(action)
		if (result.status !== 'applied') throw new Error('AI 助手停靠操作未被接纳')
		workbench.activate('assistant')
	}

	async closeDocuments(
		ids = this.workbench.getDocuments().map((document) => document.id),
	): Promise<boolean> {
		if (ids.length === 0) return true
		const result = await this.workbench.dispatch(
			Actions.group(ids.map((id) => Actions.deleteTab(id))),
		)
		if (result.status === 'failed') throw result.error
		if (result.status !== 'closed') return false
		if (result.cleanupErrors.length > 0)
			throw new AggregateError(result.cleanupErrors, '标签已关闭，但部分资源释放失败')
		return true
	}

	async closeAssistant() {
		const result = await this.workbench.close('assistant')
		if (result.status === 'failed') throw result.error
		if (result.status === 'closed' && result.cleanupErrors.length > 0)
			throw new AggregateError(result.cleanupErrors, 'AI 助手已关闭，但部分资源释放失败')
	}

	async exportProject() {
		for (const path of this.workspace.files.keys()) await this.workspace.save(path)
		for (const entry of this.workspace.documents.keys()) await this.workspace.saveInput(entry)
		if (this.workspace.isDirty()) throw new Error('请先解决未保存的修改再导出')
		const bytes = await api.exportWorkspace({ projectId: this.project.id })
		await window.studio.saveFile({ suggestedName: `${this.project.name}.zip`, bytes })
	}

	async mutate(
		path: string,
		to: string | undefined,
		action: (version: string) => Promise<unknown>,
	) {
		const { workspace, workbench } = this
		const report = workspace.tree?.documents.find(
			(document) => document.entry === `${path}/${path.split('/').at(-1)}.ts`,
		)
		const affected = (candidate: string) => candidate === path || candidate.startsWith(path + '/')
		for (const file of workspace.files.keys()) if (affected(file)) await workspace.save(file)
		for (const entry of workspace.documents.keys())
			if (affected(entry)) await workspace.saveInput(entry)
		if (
			[...workspace.files].some(([key, file]) => affected(key) && file.dirty) ||
			[...workspace.documents].some(([key, document]) => affected(key) && document.inputDirty)
		)
			throw new Error('请先解决此路径内未保存的修改')
		const active = workbench.getActiveDocument()?.id
		const tabs = workbench.getDocuments().flatMap((document) => {
			const resource = studioDocument(document.href)
			return affected(resource.path) ? [{ ...resource, id: document.id }] : []
		})
		if (!(await this.closeDocuments(tabs.map((tab) => tab.id))))
			throw new Error('标签关闭未获准，文件操作已取消')
		const reopen = async (destination?: string) => {
			const errors: unknown[] = []
			let activeId: string | undefined
			for (const tab of tabs) {
				const next = destination
					? report?.entry === tab.path
						? `${destination}/${destination.split('/').at(-1)}.ts`
						: destination + tab.path.slice(path.length)
					: tab.path
				try {
					const result = await this.open(tab.kind, next, { newInstance: true, background: true })
					if (result.status !== 'committed')
						throw new Error(`重新打开 ${next} 未完成：${result.status}`)
					if (tab.id === active) activeId = result.document.id
				} catch (error) {
					errors.push(error)
				}
			}
			if (activeId) workbench.activate(activeId)
			return errors
		}
		try {
			if (!(await workspace.refresh())) throw new Error(`无法刷新项目：${workspace.error}`)
			const item = workspace.tree?.entries.find((candidate) => candidate.path === path)
			if (!item) throw new Error('路径已不存在，请刷新文件树')
			await action(item.version)
		} catch (error) {
			const errors = await reopen()
			throw new AggregateError(
				[error, ...errors],
				`文件操作失败：${String(error)}${errors.length > 0 ? '；部分标签重新打开失败' : '；相关标签已按当前布局重新打开'}`,
				{ cause: error },
			)
		}
		for (const entry of workspace.documents.keys())
			if (affected(entry)) workspace.documents.delete(entry)
		if (!(await workspace.refresh()))
			throw new Error(`文件操作已完成，但刷新项目失败：${workspace.error}`)
		const errors = to ? await reopen(to) : []
		if (errors.length > 0)
			throw new AggregateError(errors, '文件操作已完成，但部分标签重新打开失败')
	}
}

function AssistantTool({ workspace }: { workspace: WorkspaceController }) {
	useWorkspaceState(workspace)
	return (
		<AssistantPanel
			projectId={workspace.project.id}
			uiState={workspace.assistantState}
			entries={workspace.tree?.entries ?? []}
			onChanged={() => void workspace.refresh()}
		/>
	)
}
