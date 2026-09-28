import { BasePlugin, Plugin, type ConfigSnapshot } from '@pluxel/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { expectTypeOf, it } from 'vitest'

type Settings = { endpoint: string; retry: { delays: number[] }; pair: [string, number] }
const SettingsSchema: StandardSchemaV1<unknown, Settings> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate: () => ({ value: { endpoint: 'local', retry: { delays: [10] }, pair: ['a', 1] } }),
	},
}

@Plugin()
class Configured extends BasePlugin {
	readonly config = this.configs.use(SettingsSchema)

	protected override init() {
		this.configs.onUpdate(this.config, ({ applied, desired }) => {
			expectTypeOf(applied).toEqualTypeOf<ConfigSnapshot<Settings>>()
			expectTypeOf(desired).toEqualTypeOf<ConfigSnapshot<Settings>>()
		})
	}
}

it('exposes deep readonly schema output, including arrays and tuples', () => {
	expectTypeOf<Configured['config']>().toEqualTypeOf<ConfigSnapshot<Settings>>()
	const assertConsumer = (plugin: Configured) => {
		// @ts-expect-error Config fields are frozen snapshots, not mutable runtime state.
		plugin.config.endpoint = 'other'
		// @ts-expect-error Nested arrays are frozen too.
		plugin.config.retry.delays.push(20)
		// @ts-expect-error Tuples retain their positions without permitting writes.
		plugin.config.pair[1] = 2
		const mutableDelays: number[] = [...plugin.config.retry.delays]
		mutableDelays[0] = 20
	}
	void assertConsumer
})
