import { BasePlugin, Plugin } from '@pluxel/core'

const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'control-delivery',
		types: undefined as { input: { count?: number }; output: { count: number } } | undefined,
		validate(input: unknown) {
			const count = (input as { count?: unknown })?.count ?? 2
			return typeof count === 'number'
				? { value: { count } }
				: { issues: [{ message: 'Expected numeric count', path: ['count'] }] }
		},
	},
}

@Plugin({ forkable: true })
export class DeliveryCounter extends BasePlugin {
	readonly config = this.configs.use(schema)
	count = 2
	init() {
		this.configs.onUpdate(this.config, ({ desired }) => {
			this.count = desired.count
		})
	}
	add(delta: number): number {
		return (this.count += delta)
	}
	async addAsync(delta: number, signal: AbortSignal): Promise<number> {
		signal.throwIfAborted()
		await Promise.resolve()
		return this.add(delta)
	}
}
