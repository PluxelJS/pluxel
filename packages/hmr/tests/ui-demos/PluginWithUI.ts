// packages/hmr/tests/plugins/ui-demos/PluginWithUI.ts
// 展示型插件：演示插件页面、RPC、SSE 复用等能力

import { BasePlugin, Plugin } from '@pluxel/core'
import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { SseChannel } from '@pluxel/hmr/services'
import {Collection} from '@pluxel/hmr/signaldb'

type PluginMemoEntry = {
	id: string
	message: string
	author: 'system' | 'ui'
	createdAt: number
}

@Plugin({ name: 'PluginWithUI', type: 'event' })
export class PluginWithUI extends BasePlugin {
	private startedAt = Date.now()
	private notes!: Collection<PluginMemoEntry>
	private noteSeq = 1

	override async init() {
		this.startedAt = Date.now()
		this.ctx.logger.info('[PluginWithUI] Initializing...')

		// UI 扩展示例：自带完整页面 + 自定义 Tab + Header 按钮
		this.ctx.extensionService.register({
			pluginName: 'PluginWithUI',
			entryPath: './PluginWithUI/ui/index.tsx',
		})

		// RPC：供 UI 调用
		this.ctx.rpc.registerExtension(() => new PluginWithUIRpc(this))

		// SSE：复用宿主统一 /api/sse 连接（命名空间 = 插件名）
		this.ctx.sse.registerExtension(() => this.pushNotes())

		await this.initNotes()

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
			name: this.ctx.pluginInfo.name,
		}
	}

	async getNotesSnapshot(): Promise<PluginMemoEntry[]> {
		const docs = await this.notes.find()
		return docs
			.map((note) => ({ ...note }))
			.sort((a, b) => b.createdAt - a.createdAt)
	}

	addUserNote(message: string) {
		return this.createNote(message, 'ui')
	}

	async removeNote(id: string) {
		const ok = await this.notes.removeOne({ id })
		return ok
	}

	private pushNotes() {
		return (channel: SseChannel) => {
			const sendSync = async () => {
				channel.emit('sync', { type: 'sync', notes: await this.getNotesSnapshot() })
			}

			void sendSync()
			channel.emit('tick', { type: 'tick', now: Date.now() })

			// 周期性心跳，便于 UI 展示“实时时间”
			const timer = setInterval(() => {
				channel.emit('tick', { type: 'tick', now: Date.now() })
			}, 1000)

			const onChange = () => {
				void sendSync()
			}
			this.notes.on('added', onChange)
			this.notes.on('changed', onChange)
			this.notes.on('removed', onChange)

			channel.onAbort(() => {
				this.notes.off('added', onChange)
				this.notes.off('changed', onChange)
				this.notes.off('removed', onChange)
				clearInterval(timer)
			})
			return () => {
				clearInterval(timer)
				this.notes.off('added', onChange)
				this.notes.off('changed', onChange)
				this.notes.off('removed', onChange)
			}
		}
	}

	private async initNotes() {
		const persistence = await this.ctx.pluginData.persistence<PluginMemoEntry>({
			serialize: (items) => JSON.stringify(items, null, 2),
			deserialize: (txt) => JSON.parse(txt) as PluginMemoEntry[],
		})
		this.notes = new Collection<PluginMemoEntry, string, PluginMemoEntry>({
			name: `PluginWithUI:${this.ctx.pluginInfo.name}`,
			persistence,
		})
		const existing = await this.getNotesSnapshot()
		if (existing.length === 0) {
			await this.createNote('UI 扩展已就绪，欢迎使用 👋', 'system')
		} else {
			// 恢复 seq，避免 id 冲突
			const maxId = existing.reduce((acc, n) => Math.max(acc, Number(n.id) || 0), 0)
			this.noteSeq = maxId + 1
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
		return { ...note }
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
}

declare module '@pluxel/hmr/services' {
	interface RpcExtensions {
		PluginWithUI: PluginWithUIRpc
	}

	interface SseEvents {
		PluginWithUI:
			| { type: 'sync'; notes: PluginMemoEntry[] }
			| { type: 'tick'; now: number }
	}
}
