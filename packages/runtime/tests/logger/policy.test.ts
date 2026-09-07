import { describe, expect, it, vi } from 'vitest'
import {
	RuntimePluginLogPolicy,
	parsePluginLogPolicySnapshot,
	serializePluginLogPolicySnapshot,
	type PluginLogPolicySnapshot,
	type PluginLogPolicyStore,
} from '@pluxel/runtime/logger'

function pluginAddress(index: number) {
	return {
		definition: {
			entry: { kind: 'package-root', packageName: `@test/plugin-${index}` },
			exportName: 'Plugin',
		},
		variant: 'default',
	} as const
}

const pluginA = pluginAddress(1)
const pluginB = pluginAddress(2)
const pluginC = pluginAddress(3)

describe('RuntimePluginLogPolicy', () => {
	it('applies default, override, clear, and off with one plugin lookup', () => {
		const policy = new RuntimePluginLogPolicy()
		expect(policy.allows(pluginA, 'debug')).toBe(false)
		expect(policy.allows(pluginA, 'info')).toBe(true)

		policy.setPluginLevel(pluginA, 'debug')
		expect(policy.allows(pluginA, 'debug')).toBe(true)
		expect(policy.allows(pluginB, 'debug')).toBe(false)

		policy.setPluginLevel(pluginB, 'off')
		expect(policy.allows(pluginB, 'fatal')).toBe(false)
		policy.clearPluginLevel(pluginA)
		expect(policy.allows(pluginA, 'debug')).toBe(false)
	})

	it('returns compact mutation results instead of materializing all overrides', () => {
		const overrides = Array.from({ length: 10_000 }, (_, index) => ({
			owner: pluginAddress(index),
			level: 'debug' as const,
		}))
		const policy = new RuntimePluginLogPolicy({ version: 3, defaultLevel: 'info', overrides })
		const result = policy.setPluginLevel(pluginAddress(9999), 'trace')

		expect(result).toEqual({ revision: 1, persistence: 'none' })
		expect(result).not.toHaveProperty('overrides')
		expect(
			policy
				.snapshot()
				.overrides.find(
					({ owner }) =>
						owner.definition.entry.kind === 'package-root' &&
						owner.definition.entry.packageName === '@test/plugin-9999',
				)?.level,
		).toBe('trace')
	})

	it('coalesces persistence and loads a versioned snapshot', async () => {
		let persisted: PluginLogPolicySnapshot | undefined = {
			version: 3,
			defaultLevel: 'warning',
			overrides: [{ owner: pluginA, level: 'debug' }],
		}
		const save = vi.fn(async (_profile: string, snapshot: PluginLogPolicySnapshot) => {
			persisted = snapshot
		})
		const store: PluginLogPolicyStore = {
			load: async () => persisted,
			save,
		}
		const policy = new RuntimePluginLogPolicy()
		await policy.initialize('test', store)
		expect(policy.snapshot()).toEqual(persisted)

		policy.setPluginLevel(pluginB, 'off')
		policy.setPluginLevel(pluginC, 'trace')
		await policy.flush()

		expect(save).toHaveBeenCalled()
		expect(persisted?.overrides.map(({ level }) => level)).toEqual(['debug', 'off', 'trace'])
		expect(policy.persistence).toBe('clean')
	})

	it('enforces optimistic revision checks', () => {
		const policy = new RuntimePluginLogPolicy()
		policy.assertRevision(0)
		policy.setDefaultLevel('debug')
		expect(() => policy.assertRevision(0)).toThrow('revision conflict')
		policy.assertRevision(1)
	})

	it('round-trips and validates the versioned persistence format', () => {
		const snapshot: PluginLogPolicySnapshot = {
			version: 3,
			defaultLevel: 'warning',
			overrides: [
				{ owner: pluginA, level: 'debug' },
				{ owner: pluginB, level: 'off' },
			],
		}
		expect(parsePluginLogPolicySnapshot(serializePluginLogPolicySnapshot(snapshot))).toEqual(
			snapshot,
		)
		expect(() => parsePluginLogPolicySnapshot('{"version":1,"overrides":{}}')).toThrow(
			'Unsupported plugin log policy version',
		)
	})

	it('rejects duplicate structured owners and unstructured name maps', () => {
		expect(() =>
			parsePluginLogPolicySnapshot(
				JSON.stringify({
					version: 3,
					defaultLevel: 'info',
					overrides: [
						{ owner: pluginA, level: 'debug' },
						{ owner: pluginA, level: 'off' },
					],
				}),
			),
		).toThrow('duplicate owner')
		expect(() =>
			parsePluginLogPolicySnapshot(
				JSON.stringify({ version: 3, defaultLevel: 'info', overrides: { PluginA: 'debug' } }),
			),
		).toThrow('overrides must be an array')
	})
})
