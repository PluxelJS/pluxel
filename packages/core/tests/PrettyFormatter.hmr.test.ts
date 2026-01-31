import { describe, expect, it } from 'vitest'
import type { LogRecord } from '@logtape/logtape'
import { createPluxelPrettyFormatter } from '@pluxel/core/logger'

describe('createPluxelPrettyFormatter (hmr)', () => {
	it('renders "HMR updated" as a readable text block (no ⟪k=v⟫ spam)', () => {
		const formatter = createPluxelPrettyFormatter({
			colors: false,
			icons: false,
			includeCaller: false,
			prefix: 'context',
			timestamp: () => 'T',
		})

		const record: LogRecord = {
			category: ['pluxel', 'hmr'],
			level: 'info',
			timestamp: Date.now(),
			message: ['HMR updated'],
			rawMessage: 'HMR updated',
			properties: {
				context: 'root',
				epoch: 1,
				changedFiles: 1,
				targets: 1,
				affected: 2,
				fallbackRoots: 1,
				activeServices: 22,
				batchMs: 30.6,
				commitMs: 12.3,
				plugins: { loaded: 22, enabled: 22, running: 21 },
				invalidated: { vite: 1, runner: 1 },
				hotspots: [{ id: 'src/demo/PluginVaultDemo.ts', ms: 12.6 }],
			},
		}

		const out = formatter(record)
		expect(out).toContain('HMR updated')
		expect(out).toContain('epoch=1')
		expect(out).toContain('time: batch=30.6ms commit=12.3ms')
		expect(out).toContain('plugins: loaded=22 enabled=22 running=21')
		expect(out).toContain('invalidated: vite=1 runner=1')
		expect(out).toContain('hotspots:')
		expect(out).not.toContain('⟪')
	})

	it('renders "HMR report" with a roots list (no ⟪k=v⟫ spam)', () => {
		const formatter = createPluxelPrettyFormatter({
			colors: false,
			icons: false,
			includeCaller: false,
			prefix: 'context',
			timestamp: () => 'T',
		})

		const record: LogRecord = {
			category: ['pluxel', 'hmr'],
			level: 'info',
			timestamp: Date.now(),
			message: ['HMR report'],
			rawMessage: 'HMR report',
			properties: {
				context: 'root',
				reason: 'executeFiles',
				scope: { roots: 2, entries: 9, anchors: 3 },
				plugins: { loaded: 22, enabled: 22, running: 21 },
				pluginsByRoot: { mode: 'byRoot', reasons: ['ok'] },
				builtins: { loaded: 3, enabled: 3, running: 3 },
				roots: [
					{ root: '/repo/demo', entries: 9, plugins: { loaded: 22, enabled: 22, running: 21 } },
					{ root: '/repo/extra', entries: 0, plugins: { loaded: 0, enabled: 0, running: 0 } },
				],
			},
		}

		const out = formatter(record)
		expect(out).toContain('HMR report')
		expect(out).toContain('reason=executeFiles')
		expect(out).toContain('roots=2')
		expect(out).toContain('plugins=22:22:21')
		expect(out).toContain('roots:')
		expect(out).toContain('- /repo/demo entries=9 plugins=22:22:21')
		expect(out).not.toContain('⟪')
	})

	it('renders "HMR report" with monorepo-safe pluginStats (no misleading 0:0:0 roots)', () => {
		const formatter = createPluxelPrettyFormatter({
			colors: false,
			icons: false,
			includeCaller: false,
			prefix: 'context',
			timestamp: () => 'T',
		})

		const record: LogRecord = {
			category: ['pluxel', 'hmr'],
			level: 'info',
			timestamp: Date.now(),
			message: ['HMR report'],
			rawMessage: 'HMR report',
			properties: {
				context: 'root',
				reason: 'warmup',
				scope: { roots: 2, entries: 21, anchors: 0 },
				plugins: { loaded: 12, enabled: 10, running: 9 },
				pluginsByRoot: {
					mode: 'off',
					reasons: ['all-unresolved', 'unresolved-moduleIds', 'resolve-capped'],
					unresolved: 12,
					unmapped: 0,
					resolvedSpecifiers: 0,
					resolveAttempts: 50,
					resolveLimit: 50,
				},
				builtins: { loaded: 2, enabled: 2, running: 2 },
				roots: [
					{ root: 'chatbots', entries: 0 },
					{ root: 'plugins', entries: 0 },
				],
			},
		}

		const out = formatter(record)
		expect(out).toContain('HMR report')
		expect(out).toContain('plugins=12:10:9')
		expect(out).toContain('pluginsByRoot=off')
		expect(out).toContain('- chatbots entries=0')
		expect(out).not.toContain('chatbots entries=0 plugins=')
		expect(out).not.toContain('⟪')
	})

	it('renders "HMR warmup done" as a readable text block (no ⟪k=v⟫ spam)', () => {
		const formatter = createPluxelPrettyFormatter({
			colors: false,
			icons: false,
			includeCaller: false,
			prefix: 'context',
			timestamp: () => 'T',
		})

		const record: LogRecord = {
			category: ['pluxel', 'hmr'],
			level: 'info',
			timestamp: Date.now(),
			message: ['HMR warmup done'],
			rawMessage: 'HMR warmup done',
			properties: {
				context: 'root',
				files: 42,
				scanMs: 12.3,
				warmupMs: 45.6,
				commitMs: 7.8,
				totalMs: 58.0,
				hotspots: [{ id: 'src/demo/PluginVaultDemo.ts', ms: 12.6 }],
			},
		}

		const out = formatter(record)
		expect(out).toContain('HMR warmup done')
		expect(out).toContain('files=42')
		expect(out).toContain('time: scan=12.3ms warmup=45.6ms commit=7.8ms total=58ms')
		expect(out).toContain('hotspots:')
		expect(out).not.toContain('⟪')
	})
})
