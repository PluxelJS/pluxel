import { BasePlugin, Plugin } from '@pluxel/core'

const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'script-transport-test',
		types: undefined as { input: Record<string, unknown>; output: { count: number } } | undefined,
		validate(input: unknown) {
			const count = (input as { count?: unknown })?.count ?? 2
			return typeof count === 'number'
				? { value: { count } }
				: { issues: [{ message: 'Expected number' }] }
		},
	},
}
@Plugin()
export class ScriptCounter extends BasePlugin {
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
}
