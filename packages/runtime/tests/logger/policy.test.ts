import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { LogRecord } from '@logtape/logtape'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import {
	RuntimePluginLogPolicy,
	ensureRuntimePluginPolicyLoaded,
	persistRuntimePluginPolicy,
	readPluginLogPolicyFile,
	runtimePluginLogPolicy,
	writePluginLogPolicyFile,
	type PluginLogPolicySnapshot,
} from '@pluxel/runtime/logger'
import { withRuntimeHost } from '@pluxel/runtime/test'

function record(level: 'debug' | 'info' | 'warning', pluginId?: string) {
	const out: LogRecord = {
		level,
		category: ['pluxel', 'plugins'],
		properties: pluginId ? { pluginId } : {},
		message: ['test'],
		rawMessage: 'test',
		timestamp: Date.now(),
	}
	return out
}

describe('RuntimePluginLogPolicy', () => {
	let tmp: string | undefined

	afterEach(async () => {
		runtimePluginLogPolicy.clear()
		if (tmp) await rm(tmp, { recursive: true, force: true })
		tmp = undefined
	})

	it('applies default level, overrides, clear, and off', () => {
		const policy = new RuntimePluginLogPolicy({ defaultLevel: 'info' })

		expect(policy.allows(record('debug', 'PluginA'))).toBe(false)
		expect(policy.allows(record('info', 'PluginA'))).toBe(true)

		policy.setPluginLevel('PluginA', 'debug')
		expect(policy.allows(record('debug', 'PluginA'))).toBe(true)
		expect(policy.allows(record('debug', 'PluginB'))).toBe(false)

		policy.setPluginLevel('PluginB', 'off')
		expect(policy.allows(record('warning', 'PluginB'))).toBe(false)

		policy.clearPluginLevel('PluginA')
		expect(policy.allows(record('debug', 'PluginA'))).toBe(false)
	})

	it('exposes a LogTape lookup without leaking policy off syntax', () => {
		const policy = new RuntimePluginLogPolicy()

		policy.setDefaultLevel('warning')
		policy.setPluginLevel('PluginA', 'off')
		policy.setPluginLevel('PluginB', 'debug')

		expect(policy.lookupLogtapeLevel('PluginA')).toBeNull()
		expect(policy.lookupLogtapeLevel('PluginB')).toBe('debug')
		expect(policy.lookupLogtapeLevel('PluginC')).toBe('warning')
		expect(policy.snapshot()).toEqual({
			defaultLevel: 'warning',
			overrides: { PluginA: 'off', PluginB: 'debug' },
		})

		policy.clearDefaultLevel()
		expect(policy.lookupLogtapeLevel('PluginC')).toBeUndefined()
	})

	it('round-trips policy snapshots through disk', async () => {
		tmp = await mkdtemp(join(tmpdir(), 'pluxel-logger-policy-'))
		const path = join(tmp, 'logging-policy.json')
		const snapshot: PluginLogPolicySnapshot = {
			defaultLevel: 'warning',
			overrides: { PluginA: 'debug', PluginB: 'off' },
		}

		await writePluginLogPolicyFile(path, snapshot)

		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(snapshot)
		await expect(readPluginLogPolicyFile(path)).resolves.toEqual(snapshot)
		await expect(readPluginLogPolicyFile(join(tmp, 'missing.json'))).resolves.toBeNull()
	})

	it('rejects legacy null levels instead of treating them as off', async () => {
		tmp = await mkdtemp(join(tmpdir(), 'pluxel-logger-policy-'))
		const path = join(tmp, 'legacy-policy.json')
		await writeFile(path, '{"overrides":{"PluginA":null}}\n')

		await expect(readPluginLogPolicyFile(path)).rejects.toThrow('Invalid plugin log level')
	})

	it('loads and persists runtime policy through persistence namespace', async () => {
		runtimePluginLogPolicy.clear()

		await withRuntimeHost(
			async (host) => {
				const storage = host.ctx.root.persistence.namespace('logger')
				const key = 'plugin-policy/test-profile.json'
				await storage.put(
					key,
					`${JSON.stringify({
						defaultLevel: 'warning',
						overrides: { PluginA: 'debug' },
					} satisfies PluginLogPolicySnapshot)}\n`,
				)

				await ensureRuntimePluginPolicyLoaded(host.ctx)
				expect(runtimePluginLogPolicy.snapshot()).toEqual({
					defaultLevel: 'warning',
					overrides: { PluginA: 'debug' },
				})

				runtimePluginLogPolicy.setPluginLevel('PluginB', 'off')
				await persistRuntimePluginPolicy(host.ctx)

				expect(JSON.parse((await storage.getText(key)) ?? '{}')).toEqual({
					defaultLevel: 'warning',
					overrides: { PluginA: 'debug', PluginB: 'off' },
				})
			},
			{ persistence: { mode: 'memory' }, profile: 'test-profile' },
		)
	})
})
