import { type Context, Injectable } from '@pluxel/context'

declare module '@pluxel/context' {
	interface Context {
		scope: EffectScopeService
		collect: EffectScopeService['collect']
		disposeAll: EffectScopeService['disposeAll']
	}
}

@Injectable
export class EffectScopeService {
	static key = 'scope'
	static methods = ['collect', 'disposeAll'] as const

	private pluginName = 'global'

	public get name() {
		return this.pluginName
	}
	public set name(v: string) {
		this.pluginName = v
	}

	private disposables: Array<() => void> = []

	constructor(private ctx: Context) {}

	/** 注册一个清理函数到当前 ctx */
	collect(fn: () => void) {
		this.disposables.push(fn)
	}

	/** 一次性清理当前 ctx 下的所有副作用 */
	disposeAll() {
		for (const fn of this.disposables) {
			try {
				fn()
			} catch {
				/* ignore */
			}
		}
		this.disposables = []
	}
}
