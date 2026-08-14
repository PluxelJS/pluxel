import { describe, expect, it, vi } from 'vitest'
import {
	RuntimePluginLogPolicy,
	parsePluginLogPolicySnapshot,
	serializePluginLogPolicySnapshot,
	type PluginLogPolicySnapshot,
	type PluginLogPolicyStore,
} from '@pluxel/runtime/logger'

describe('RuntimePluginLogPolicy', () => {
	it('applies default, override, clear, and off with one plugin lookup', () => {
		const policy = new RuntimePluginLogPolicy()
		expect(policy.allows('PluginA', 'debug')).toBe(false)
		expect(policy.allows('PluginA', 'info')).toBe(true)

		policy.setPluginLevel('PluginA', 'debug')
		expect(policy.allows('PluginA', 'debug')).toBe(true)
		expect(policy.allows('PluginB', 'debug')).toBe(false)

		policy.setPluginLevel('PluginB', 'off')
		expect(policy.allows('PluginB', 'fatal')).toBe(false)
		policy.clearPluginLevel('PluginA')
		expect(policy.allows('PluginA', 'debug')).toBe(false)
	})

	it('returns compact mutation results instead of materializing all overrides', () => {
		const overrides = Object.fromEntries(
			Array.from({ length: 10_000 }, (_, index) => [`Plugin${index}`, 'debug'] as const),
		)
		const policy = new RuntimePluginLogPolicy({ version: 1, defaultLevel: 'info', overrides })
		const result = policy.setPluginLevel('Plugin9999', 'trace')

		expect(result).toEqual({ revision: 1, persistence: 'none' })
		expect(result).not.toHaveProperty('overrides')
		expect(policy.snapshot().overrides.Plugin9999).toBe('trace')
	})

	it('coalesces persistence and loads a versioned snapshot', async () => {
		let persisted: PluginLogPolicySnapshot | undefined = {
			version: 1,
			defaultLevel: 'warning',
			overrides: { PluginA: 'debug' },
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

		policy.setPluginLevel('PluginB', 'off')
		policy.setPluginLevel('PluginC', 'trace')
		await policy.flush()

		expect(save).toHaveBeenCalled()
		expect(persisted?.overrides).toMatchObject({
			PluginA: 'debug',
			PluginB: 'off',
			PluginC: 'trace',
		})
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
			version: 1,
			defaultLevel: 'warning',
			overrides: { PluginA: 'debug', PluginB: 'off' },
		}
		expect(parsePluginLogPolicySnapshot(serializePluginLogPolicySnapshot(snapshot))).toEqual(
			snapshot,
		)
		expect(() => parsePluginLogPolicySnapshot('{"version":1,"overrides":{}}')).toThrow(
			'Invalid plugin log level',
		)
	})

	it('bounds plugin identifiers in persisted and dynamic overrides', () => {
		const oversized = 'x'.repeat(513)
		const policy = new RuntimePluginLogPolicy()
		expect(() => policy.setPluginLevel(oversized, 'debug')).toThrow('too long')
		expect(() =>
			parsePluginLogPolicySnapshot(
				JSON.stringify({
					version: 1,
					defaultLevel: 'info',
					overrides: { [oversized]: 'debug' },
				}),
			),
		).toThrow('oversized plugin id')
	})
})
