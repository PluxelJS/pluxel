// packages/hmr/tests/plugins/ui-demos/PluginWithUI.ts
// 展示型插件：演示插件页面、RPC、SSE 复用等能力

import { BasePlugin, Plugin } from '@pluxel/core'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { SseChannel } from '@pluxel/hmr/services'
import { Collection, createIndex } from '@pluxel/hmr/signaldb'

type PluginMemoEntry = {
	id: string
	message: string
	author: 'system' | 'ui'
	createdAt: number
}

type PluginTaskEntry = {
	id: string
	title: string
	priority: 'low' | 'medium' | 'high'
	status: 'todo' | 'doing' | 'done'
	tags: string[]
	dueAt?: number
	createdAt: number
	updatedAt: number
}

type PluginActivityEntry = {
	id: string
	scope: 'note' | 'task'
	action: 'created' | 'updated' | 'removed'
	detail: string
	at: number
}

@Plugin({ name: 'PluginWithUI', type: 'event' })
export class PluginWithUI extends BasePlugin {
	private startedAt = Date.now()
	private notes!: Collection<PluginMemoEntry>
	private tasks!: Collection<PluginTaskEntry>
	private activity!: Collection<PluginActivityEntry>
	private noteSeq = 1
	private taskSeq = 1
	private activitySeq = 1

	override async init() {
		this.startedAt = Date.now()
		this.ctx.logger.info('[PluginWithUI] Initializing...')

		await this.initData()

		// UI 扩展示例：自带完整页面 + 自定义 Tab + Header 按钮
		this.ctx.extensionService.register({
			entryPath: './PluginWithUI/ui/index.tsx',
		})

		// RPC：供 UI 调用
		this.ctx.rpc.registerExtension(() => new PluginWithUIRpc(this))

		// SSE：复用宿主统一 /api/sse 连接（命名空间 = 插件名）
		this.ctx.sse.registerExtension(() => this.pushData())

		this.ctx.logger.info('[PluginWithUI] UI extensions registered')
	}

	override async stop() {
		this.ctx.logger.info('[PluginWithUI] Stopping...')
	}

	getStatus() {
		return {
			status: 'running',
			startedAt: this.startedAt,
			uptimeMs: Date.now() - this.startedAt,
			noteCount: this.noteSeq - 1,
			taskCount: this.taskSeq - 1,
			name: this.ctx.pluginInfo.id,
		}
	}

	async getNotesSnapshot(): Promise<PluginMemoEntry[]> {
		const docs = await this.notes.find()
		return docs.map((note) => ({ ...note })).sort((a, b) => b.createdAt - a.createdAt)
	}

	addUserNote(message: string) {
		return this.createNote(message, 'ui')
	}

	async removeNote(id: string) {
		const ok = await this.notes.removeOne({ id })
		if (ok) {
			await this.recordActivity({
				scope: 'note',
				action: 'removed',
				detail: `删除备注 #${id}`,
			})
		}
		return ok
	}

	async getTasksSnapshot(): Promise<PluginTaskEntry[]> {
		return this.getSortedTasks()
	}

	async addTask(input: { title: string; priority?: PluginTaskEntry['priority']; tags?: string[]; dueAt?: number }) {
		const title = input.title.trim()
		if (!title) {
			throw new Error('任务标题不能为空')
		}

		const task: PluginTaskEntry = {
			id: String(this.taskSeq++),
			title,
			priority: input.priority ?? 'medium',
			status: 'todo',
			tags: input.tags?.length ? input.tags : ['demo', 'signaldb'],
			dueAt: input.dueAt,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		}

		await this.tasks.insert(task)
		await this.recordActivity({
			scope: 'task',
			action: 'created',
			detail: `新增任务「${title}」`,
		})

		return { ...task }
	}

	async toggleTaskStatus(id: string, status?: PluginTaskEntry['status']) {
		const task = this.tasks.findOne({ id })
		if (!task) {
			throw new Error(`任务 ${id} 不存在`)
		}

		const nextStatus: PluginTaskEntry['status'] =
			status ?? (task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : 'todo')

		this.tasks.updateOne(
			{ id },
			{
				$set: {
					status: nextStatus,
					updatedAt: Date.now(),
				},
			},
		)

		await this.recordActivity({
			scope: 'task',
			action: 'updated',
			detail: `任务 #${id} 状态：${task.status} → ${nextStatus}`,
		})

		return { id, status: nextStatus }
	}

	async clearFinishedTasks() {
		const removed = this.tasks.removeMany({ status: 'done' })
		if (removed > 0) {
			await this.recordActivity({
				scope: 'task',
				action: 'removed',
				detail: `清理 ${removed} 个已完成任务`,
			})
		}
		return { removed }
	}

	async getActivitySnapshot(limit = 24) {
		const docs = await this.activity.find()
		return docs
			.map((item) => ({ ...item }))
			.sort((a, b) => b.at - a.at)
			.slice(0, limit)
	}

	private pushData() {
		return (channel: SseChannel) => {
			const sendSync = async () => {
				channel.emit('sync', {
					type: 'sync',
					...this.getCursorPayload(),
				})
			}

			const sendCursor = () => {
				channel.emit('cursor', {
					type: 'cursor',
					...this.getCursorPayload(),
				})
			}

			void sendSync()
			channel.emit('tick', { type: 'tick', now: Date.now() })
			sendCursor()

			// 周期性心跳，便于 UI 展示“实时时间”
			const timer = setInterval(() => {
				channel.emit('tick', { type: 'tick', now: Date.now() })
			}, 1000)

			// 用 cursor 监听变更，演示 SignalDB 事件驱动同步
			const notesCursor = this.notes.find({}, { sort: { createdAt: -1 }, limit: 12 })
			const tasksCursor = this.tasks.find({}, { limit: 48 })
			const activityCursor = this.activity.find({}, { sort: { at: -1 }, limit: 32 })

			const onCursorChange = () => {
				sendCursor()
			}
			const stopNotes = notesCursor.observeChanges(
				{
					added: onCursorChange,
					changed: onCursorChange,
					removed: onCursorChange,
				},
				true,
			)
			const stopTasks = tasksCursor.observeChanges(
				{
					added: onCursorChange,
					changed: onCursorChange,
					removed: onCursorChange,
				},
				true,
			)
			const stopActivity = activityCursor.observeChanges(
				{
					added: onCursorChange,
					changed: onCursorChange,
					removed: onCursorChange,
				},
				true,
			)

			channel.onAbort(() => {
				stopNotes?.()
				stopTasks?.()
				stopActivity?.()
				notesCursor.cleanup()
				tasksCursor.cleanup()
				activityCursor.cleanup()
				clearInterval(timer)
			})
			return () => {
				clearInterval(timer)
				stopNotes?.()
				stopTasks?.()
				stopActivity?.()
				notesCursor.cleanup()
				tasksCursor.cleanup()
				activityCursor.cleanup()
			}
		}
	}

	private async initData() {
		const notesPersistence = await this.ctx.pluginData.persistenceForCollection<PluginMemoEntry>('notes')
		this.notes = new Collection<PluginMemoEntry, string, PluginMemoEntry>({
			name: 'notes',
			persistence: notesPersistence,
		})
		this.tasks = new Collection<PluginTaskEntry, string, PluginTaskEntry>({
			name: 'tasks',
			persistence: await this.ctx.pluginData.persistenceForCollection<PluginTaskEntry>('tasks'),
			indices: [createIndex('status'), createIndex('priority')],
		})
		this.activity = new Collection<PluginActivityEntry, string, PluginActivityEntry>({
			name: 'activity',
			persistence: await this.ctx.pluginData.persistenceForCollection<PluginActivityEntry>('activity'),
		})

		const existing = await this.getNotesSnapshot()
		if (existing.length === 0) {
			await this.createNote('UI 扩展已就绪，欢迎使用 👋', 'system')
		} else {
			// 恢复 seq，避免 id 冲突
			const maxId = existing.reduce((acc, n) => Math.max(acc, Number(n.id) || 0), 0)
			this.noteSeq = maxId + 1
		}

		const existingTasks = await this.getTasksSnapshot()
		if (existingTasks.length === 0) {
			await this.addTask({ title: '看看 SignalDB 多 Collection 用法', priority: 'high', tags: ['signaldb'] })
			await this.addTask({ title: '随手添加备注试试', priority: 'medium' })
			await this.addTask({ title: '切换任务状态，观察 SSE 同步', priority: 'low', tags: ['demo'] })
		} else {
			const maxTaskId = existingTasks.reduce((acc, n) => Math.max(acc, Number(n.id) || 0), 0)
			this.taskSeq = maxTaskId + 1
		}

		const existingActivity = this.activity
			.find({}, { limit: 128 })
			.fetch()
			.map((item) => ({ ...item }))
		if (existingActivity.length > 0) {
			const maxActivityId = existingActivity.reduce((acc, item) => Math.max(acc, Number(item.id) || 0), 0)
			this.activitySeq = maxActivityId + 1
		}
	}

	private async createNote(message: string, author: PluginMemoEntry['author']) {
		const trimmed = message.trim()
		if (!trimmed) {
			throw new Error('备注内容不能为空')
		}

		const note: PluginMemoEntry = {
			id: String(this.noteSeq++),
			message: trimmed,
			author,
			createdAt: Date.now(),
		}

		await this.notes.insert(note)
		await this.recordActivity({
			scope: 'note',
			action: 'created',
			detail: `新增备注 #${note.id}`,
		})
		return { ...note }
	}

	private async recordActivity(entry: Omit<PluginActivityEntry, 'id' | 'at'>) {
		const activity: PluginActivityEntry = {
			id: String(this.activitySeq++),
			at: Date.now(),
			...entry,
		}
		await this.activity.insert(activity)

		// 控制活动列表长度，避免 UI 演示时无限增长
		const items = await this.activity.find()
		if (items.count() > 32) {
			const sorted = items
				.map((item) => item)
				.sort((a, b) => a.at - b.at)
				.slice(0, items.count() - 24)
			for (const oldItem of sorted) {
				this.activity.removeOne({ id: oldItem.id })
			}
		}
	}

	private getCursorPayload() {
		const notes = this.notes.find({}, { sort: { createdAt: -1 }, limit: 12 }).fetch().map((note) => ({ ...note }))
		const tasks = this.getSortedTasks(48)
		const activity = this.activity.find({}, { sort: { at: -1 }, limit: 32 }).fetch().map((item) => ({ ...item }))
		return { notes, tasks, activity }
	}

	private getSortedTasks(limit = 64) {
		return this.tasks
			.find({}, { limit })
			.fetch()
			.map((task) => ({ ...task }))
			.sort((a, b) => {
				if (a.status !== b.status) {
					return a.status === 'done' ? 1 : -1
				}
				if (a.priority !== b.priority) {
					const priorityRank = { high: 0, medium: 1, low: 2 } as const
					return priorityRank[a.priority] - priorityRank[b.priority]
				}
				return b.updatedAt - a.updatedAt
			})
	}
}

export class PluginWithUIRpc extends RpcTarget {
	constructor(private readonly plugin: PluginWithUI) {
		super()
	}

	overview() {
		const status = this.plugin.getStatus()
		return {
			...status,
			version: 'dev',
			lastHeartbeat: Date.now(),
		}
	}

	notes() {
		return this.plugin.getNotesSnapshot()
	}

	addNote(message: string) {
		return this.plugin.addUserNote(message)
	}

	async removeNote(id: string) {
		return { ok: await this.plugin.removeNote(id) }
	}

	tasks() {
		return this.plugin.getTasksSnapshot()
	}

	addTask(input: { title: string; priority?: PluginTaskEntry['priority']; tags?: string[]; dueAt?: number }) {
		return this.plugin.addTask(input)
	}

	updateTaskStatus(id: string, status?: PluginTaskEntry['status']) {
		return this.plugin.toggleTaskStatus(id, status)
	}

	clearFinishedTasks() {
		return this.plugin.clearFinishedTasks()
	}

	activity() {
		return this.plugin.getActivitySnapshot()
	}
}

declare module '@pluxel/hmr/services' {
	interface RpcExtensions {
		PluginWithUI: PluginWithUIRpc
	}

	interface SseEvents {
		PluginWithUI:
			| { type: 'sync'; notes: PluginMemoEntry[]; tasks: PluginTaskEntry[]; activity: PluginActivityEntry[] }
			| { type: 'tick'; now: number }
			| { type: 'cursor'; notes: PluginMemoEntry[]; tasks: PluginTaskEntry[]; activity: PluginActivityEntry[] }
	}
}
