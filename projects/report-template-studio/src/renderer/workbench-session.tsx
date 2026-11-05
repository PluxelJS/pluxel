import { createWorkbench, type OpenResult, type OpenOptions } from '@worksplit/react'
import { Actions, DockLocation } from 'flexlayout-react'
import type { ProjectSummary } from '../shared/contracts'
import { api } from './api'
import { AssistantPanel } from './assistant'
import { WorkspaceController, useWorkspaceState } from './workspace'
import { assistantTab, createStudioLayout, documentTarget } from './workbench-layout'
import { createStudioRouter, studioDocument, type StudioDocument } from './workbench-routes'

/** One project owns business state and one Worksplit instance. Shell components borrow them. */
export class StudioSession {
	readonly workspace: WorkspaceController
	readonly workbench
	private starting?: Promise<void>
	private disposing?: Promise<void>
	private closed = false
	private documentRequested = false
	private disconnectSource: () => void

	constructor(readonly project: ProjectSummary) {
		const workspace = (this.workspace = new WorkspaceController(project))
		const basis = () =>
			JSON.stringify([
				[...workspace.files].map(([path, file]) => [
					path,
					file.token,
					file.external,
					!!file.missing,
				]),
				[...workspace.documents].map(([entry, document]) => [
					entry,
					document.inputToken,
					document.inputEpoch,
				]),
			])
		const leaveState = () => ({
			hasUnsavedChanges: workspace.isDirty(),
			token: JSON.stringify([
				basis(),
				[...workspace.files.values()].map((file) => file.saving),
				[...workspace.documents.values()].map((document) => [
					document.inputSaving,
					document.bodyLocked,
					!!document.inputConflict,
				]),
			]),
		})
		this.workbench = createWorkbench({
			workspaceId: project.id,
			home: { href: '/', mode: 'empty' },
			createRouter: createStudioRouter,
			initial: { layout: createStudioLayout() },
			workspaceLeave: {
				getState: leaveState,
				async decide(request) {
					const reviewed = basis()
					await Promise.all([
						...[...workspace.files.keys()].map((path) => workspace.save(path)),
						...[...workspace.documents.keys()].map((entry) => workspace.saveInput(entry)),
					])
					if (request.signal.aborted || basis() !== reviewed || workspace.isDirty())
						return { decision: 'deny' }
					for (const path of new Set([...workspace.files.keys(), ...workspace.documents.keys()]))
						request.defer(workspace.pauseEditing(path))
					return { decision: 'allow', token: leaveState().token }
				},
			},
			tools: { 'studio.assistant': { render: () => <AssistantTool workspace={workspace} /> } },
			onIssue: ({ code, id, error }) =>
				this.report(
					new Error(`${code}${id ? ` (${id})` : ''}: ${String(error)}`, { cause: error }),
				),
		})
		this.disconnectSource = workspace.connectSourceNavigation(async (path) => {
			const result = await this.open('file', path)
			return result.status === 'applied'
		})
	}

	report(cause: unknown) {
		this.workspace.error = cause instanceof Error ? cause.message : String(cause)
		this.workspace.emit()
	}

	start(): Promise<void> {
		return (this.starting ??= (async () => {
			if (this.closed) throw new Error('项目已关闭')
			const result = await this.workbench.start({ href: '/' })
			if (result.status === 'failed') throw result.error
			if (this.closed || result.status !== 'applied') return
			this.workspace.start()
			if (!(await this.workspace.refresh())) return
			const first = this.workspace.tree?.documents[0]
			if (
				!this.closed &&
				!this.documentRequested &&
				first &&
				this.workbench.getDocuments().length === 0
			)
				await this.openReport(first.entry)
		})())
	}

	dispose(): Promise<void> {
		if (this.disposing) return this.disposing
		this.closed = true
		this.disconnectSource()
		return (this.disposing = (async () => {
			try {
				const result = await this.workbench.dispose()
				this.check(result, '项目内容已关闭，但部分资源释放失败')
			} finally {
				this.workspace.dispose()
			}
		})())
	}

	async open(
		kind: StudioDocument['kind'],
		path: string,
		options: Omit<OpenOptions, 'destination' | 'preview'> = {},
	): Promise<OpenResult> {
		// Startup's default report cannot replace an explicit request that is still loading.
		this.documentRequested = true
		const { workbench } = this
		const destination = documentTarget(
			kind,
			workbench.getContainers(),
			workbench.getDocuments(),
			workbench.getContext().activeContainerId,
		)
		const source = options.source ?? workbench.getActiveDocument()?.handle
		const sourceContainer = source && workbench.getContent(source.id)?.containerId
		const canReveal =
			kind === 'preview' &&
			source &&
			destination &&
			(destination.location !== DockLocation.CENTER || destination.target !== sourceContainer) &&
			!workbench.model.getMaximizedTabset()
		const presentation = options.presentation ?? (canReveal ? 'reveal' : 'activate')
		const placement = { destination, source, ...options, presentation }
		const result =
			kind === 'file'
				? await workbench.open({ to: '/file', search: { path } }, placement)
				: kind === 'form'
					? await workbench.open({ to: '/form', search: { entry: path } }, placement)
					: await workbench.open({ to: '/preview', search: { entry: path } }, placement)
		this.check(result, '文档已打开，但部分内容资源释放失败')
		return result
	}

	async openReport(path: string): Promise<void> {
		const result = await this.open('form', path)
		if (
			result.status !== 'applied' ||
			result.value.presentation !== 'activate' ||
			this.workbench.getActiveDocument()?.id !== result.value.document.id
		)
			return
		this.workspace.preferPreview(path)
		await this.open('preview', path, { source: result.value.document.handle })
	}

	async showAssistant(dock?: 'bottom' | 'right') {
		const { workbench } = this
		if (!dock && workbench.getContent('assistant')) {
			this.check(await workbench.activate('assistant'), 'AI 助手激活失败')
			return
		}
		const destination = dock ?? 'bottom'
		if (!workbench.getContainers().some((container) => container.id === `border_${destination}`))
			throw new Error(`当前布局没有 ${destination} 停靠区`)
		const action = workbench.getContent('assistant')
			? Actions.moveNode('assistant', `border_${destination}`, DockLocation.CENTER, -1, true)
			: Actions.addTab({ ...assistantTab }, `border_${destination}`, DockLocation.CENTER, -1, true)
		const result = await workbench.dispatch(action)
		if (result.status !== 'applied') throw new Error('AI 助手停靠操作未被接纳')
		this.check(await workbench.activate('assistant'), 'AI 助手激活失败')
	}

	async closeDocuments(
		ids = this.workbench.getDocuments().map((document) => document.id),
	): Promise<boolean> {
		if (ids.length === 0) return true
		const result = await this.workbench.close(ids)
		if (result.status === 'failed') throw result.error
		if (result.status !== 'applied') return false
		if (result.cleanupErrors.length > 0)
			throw new AggregateError(result.cleanupErrors, '标签已关闭，但部分资源释放失败')
		return true
	}

	async closeAssistant() {
		const result = await this.workbench.close('assistant')
		if (result.status === 'failed') throw result.error
		if (result.status === 'applied' && result.cleanupErrors.length > 0)
			throw new AggregateError(result.cleanupErrors, 'AI 助手已关闭，但部分资源释放失败')
	}

	private check(
		result: { status: string; error?: unknown; cleanupErrors?: readonly unknown[] },
		message: string,
	) {
		if (result.status === 'failed') throw result.error
		if (result.cleanupErrors?.length) throw new AggregateError(result.cleanupErrors, message)
	}

	async closeWorkspace(): Promise<boolean> {
		const result = await this.workbench.closeWorkspace()
		if (result.status === 'failed') throw result.error
		if (result.status !== 'applied') return false
		if (result.cleanupErrors.length > 0)
			this.report(new AggregateError(result.cleanupErrors, '项目已关闭，但部分内容资源释放失败'))
		return true
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
					const canOpenInBackground = workbench
						.getContainers()
						.some((container) => container.kind === 'tabset' && container.selectedId)
					const result = await this.open(tab.kind, next, {
						reuse: 'new',
						presentation: canOpenInBackground ? 'background' : 'activate',
					})
					if (result.status !== 'applied')
						throw new Error(`重新打开 ${next} 未完成：${result.status}`)
					if (tab.id === active) activeId = result.value.document.id
				} catch (error) {
					errors.push(error)
				}
			}
			if (activeId) this.check(await workbench.activate(activeId), '文件已重新打开，但激活失败')
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
