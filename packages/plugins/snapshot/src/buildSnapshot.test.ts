import { describe, expect, test } from 'vitest'
import type { Context, PluginConstructor } from '@pluxel/core'
import { buildSnapshotSource } from './buildSnapshot'

class PluginB {}
class PluginC {}

const registryStub = new Map<string, PluginConstructor>([
	['PluginB', PluginB as unknown as PluginConstructor],
	['PluginC', PluginC as unknown as PluginConstructor],
])

function createContextStub(config: Record<string, object>): Pick<Context, 'configService'> {
	return {
		configService: {
			getRawConfig(name: string) {
				return config[name] ?? {}
			},
		} as any,
	}
}

describe('buildSnapshotSource', () => {
	test('generates snapshot for running plugins with config data', () => {
		const ctx = createContextStub({
			PluginB: { level: 2 },
			PluginC: { feature: 'alpha' },
		})

		const snapshot = buildSnapshotSource({
			ctx,
			entries: registryStub,
			isRunning: () => true,
			findModuleId: (name) => `/abs/path/${name}.ts`,
			getExportKey: () => 'default',
			now: new Date('2020-01-01T00:00:00.000Z'),
		})

		expect(snapshot).toContain('PluginB')
		expect(snapshot).toContain('PluginC')
		expect(snapshot).toContain('level: 2')
		expect(snapshot).toContain('feature: "alpha"')
	})
})
