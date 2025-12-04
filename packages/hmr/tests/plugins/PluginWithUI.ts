// packages/hmr/tests/plugins/PluginWithUI.ts
// 示例：带有 UI 扩展的插件

import { BasePlugin, Plugin } from '@pluxel/core'
import { RpcTarget } from 'capnweb'

type PluginMemoEntry = {
	id: number
	message: string
	author: 'system' | 'ui'
	createdAt: number
}

@Plugin({ name: 'PluginWithUI', type: 'event' })
export class PluginWithUI extends BasePlugin {
	private startedAt = Date.now()
	private notes: PluginMemoEntry[] = []
	private noteSeq = 1
	private noteSubscribers = new Set<(note: PluginMemoEntry | null, kind: 'note' | 'sync') => void>()

	override async init() {
		this.startedAt = Date.now()
		this.ctx.logger.info('[PluginWithUI] Initializing...')

		// 注册 UI 扩展入口，实际扩展在入口模块内声明
		this.ctx.extensionService.register({
			pluginName: 'PluginWithUI',
			entryPath: './ui/index.tsx',
		})

		this.ctx.rpc.registerExtension(() => new PluginWithUIRpc(this))
		this.ctx.sse.registerExtension(() => this.pushNotes())
		this.createNote('UI 扩展已就绪，欢迎使用 👋', 'system')

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
			noteCount: this.notes.length,
			name: this.ctx.pluginInfo.name,
		}
	}

	getNotesSnapshot(): PluginMemoEntry[] {
		return this.notes.map((note) => ({ ...note }))
	}

	addUserNote(message: string) {
		return this.createNote(message, 'ui')
	}

	removeNote(id: number) {
		const sizeBefore = this.notes.length
		this.notes = this.notes.filter((note) => note.id !== id)
		const removed = sizeBefore !== this.notes.length
		if (removed) {
			this.notifyNote(this.notes[0] ?? null, 'note')
		}
		return removed
	}

	private pushNotes() {
		return (channel: SseChannel) => {
			// 首次同步全量，方便 UI 初始化
			channel.emit('sync', { type: 'sync', notes: this.getNotesSnapshot() })
			channel.emit('tick', { type: 'tick', now: Date.now() })

			// 周期性心跳，便于 UI 展示“实时时间”
			const timer = setInterval(() => {
				channel.emit('tick', { type: 'tick', now: Date.now() })
			}, 1000)

			const unsubscribe = this.subscribeNotes((note, kind) => {
				if (kind === 'sync') {
					channel.emit('sync', { type: 'sync', notes: this.getNotesSnapshot() })
					return
				}
				channel.emit('note', note)
			})
			channel.onAbort(unsubscribe)
			channel.onAbort(() => clearInterval(timer))
			return () => {
				unsubscribe()
				clearInterval(timer)
			}
		}
	}

	private createNote(message: string, author: PluginMemoEntry['author']) {
		const trimmed = message.trim()
		if (!trimmed) {
			throw new Error('备注内容不能为空')
		}

		const note: PluginMemoEntry = {
			id: this.noteSeq++,
			message: trimmed,
			author,
			createdAt: Date.now(),
		}

		this.notes = [note, ...this.notes].slice(0, 8)
		this.notifyNote(note, 'note')
		return { ...note }
	}

	private subscribeNotes(
		fn: (note: PluginMemoEntry | null, kind: 'note' | 'sync') => void,
	): () => void {
		this.noteSubscribers.add(fn)
		return () => this.noteSubscribers.delete(fn)
	}

	private notifyNote(note: PluginMemoEntry | null, kind: 'note' | 'sync') {
		for (const fn of this.noteSubscribers) {
			try {
				fn(note ? { ...note } : null, kind)
			} catch (error) {
				this.ctx.logger.warn('[PluginWithUI] note subscriber failed', error)
			}
		}
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

	removeNote(id: number) {
		return { ok: this.plugin.removeNote(id) }
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
