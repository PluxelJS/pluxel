import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import type { Context } from '@pluxel/core'
import { buildSnapshot } from '../src/services/loader/buildSnapshot'
import type { PluginRegistry } from '../src/services/loader/PluginRegistry'
import { PluginB, PluginC } from './plugins'

const pluginDir = join(process.cwd(), 'packages/hmr/tests/plugins')

const registryStub = new Map<string, Function>([
	['PluginB', PluginB],
	['PluginC', PluginC],
])

const pathMap = new Map<string, string>([
	['PluginB', join(pluginDir, 'PluginB.ts')],
	['PluginC', join(pluginDir, 'PluginC.ts')],
])

function createContextStub(config: Record<string, object>): Context {
	return {
		configService: {
			getConfig(name: string) {
				return config[name] ?? {}
			},
		},
	} as unknown as Context
}

function createRegistryStub(): PluginRegistry {
	return {
		names: registryStub,
		name2PathMap: pathMap,
		getExportKeyByName(name: string) {
			return 'default'
		},
	} as unknown as PluginRegistry
}

describe('buildSnapshot', () => {
	it('generates snapshot for running plugins with config data', () => {
		const ctx = createContextStub({
			PluginB: { level: 2 },
			PluginC: { feature: 'alpha' },
		})

		const snapshot = buildSnapshot({
			ctx,
			registry: createRegistryStub(),
			isRunning: () => true,
		})

		expect(snapshot).toContain('PluginB')
		expect(snapshot).toContain('PluginC')
		expect(snapshot).toContain('level: 2')
		expect(snapshot).toContain('feature: "alpha"')
	})
})
