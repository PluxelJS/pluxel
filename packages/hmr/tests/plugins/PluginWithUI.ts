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

	override async init() {
		this.startedAt = Date.now()
		this.ctx.logger.info('[PluginWithUI] Initializing...')

		// 注册 UI 扩展入口，实际扩展在入口模块内声明
		this.ctx.extensionService.register({
			pluginName: 'PluginWithUI',
			entryPath: './ui/index.tsx',
		})

		this.ctx.rpc.registerExtension(() => new PluginWithUIRpc(this))
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
		return sizeBefore !== this.notes.length
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

	removeNote(id: number) {
		return { ok: this.plugin.removeNote(id) }
	}
}

declare module '@pluxel/hmr' {
	interface RpcExtensions {
		PluginWithUI: PluginWithUIRpc
	}
}
