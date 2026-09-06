import { describe, expect, it } from 'vitest'

import {
	clonePluginExecutionSnapshot,
	clonePluginRecentUpdateSnapshot,
	UNREPORTED_PLUGIN_EXECUTION,
} from '../src/plugin-execution'

const validExecutions = [
	{
		kind: 'static-bundle',
		artifact: { kind: 'application-bundle' },
		update: { kind: 'deployment' },
	},
	{
		kind: 'static-catalog',
		artifact: { kind: 'source-module' },
		update: { kind: 'catalog-hmr' },
	},
	{
		kind: 'static-catalog',
		artifact: { kind: 'built-module' },
		update: { kind: 'manual' },
	},
	{
		kind: 'static-catalog',
		artifact: { kind: 'unreported' },
		update: { kind: 'manual' },
	},
	{
		kind: 'dynamic-fixed',
		artifact: { kind: 'source-module' },
		update: { kind: 'host-reload' },
	},
	{
		kind: 'dynamic-fixed',
		artifact: { kind: 'built-module' },
		update: { kind: 'host-reload' },
	},
	{
		kind: 'dynamic-fixed',
		artifact: { kind: 'unreported' },
		update: { kind: 'host-reload' },
	},
	{
		kind: 'dynamic-entry',
		artifact: { kind: 'source-module' },
		update: { kind: 'definition-hmr', scope: 'source-graph' },
	},
	{
		kind: 'dynamic-entry',
		artifact: { kind: 'built-module' },
		update: { kind: 'definition-hmr', scope: 'entry-only' },
	},
	{
		kind: 'dynamic-entry',
		artifact: { kind: 'unreported' },
		update: { kind: 'definition-hmr', scope: 'entry-only' },
	},
	{
		kind: 'unreported',
		artifact: { kind: 'unreported' },
		update: { kind: 'unreported' },
	},
] as const

describe('Plugin execution snapshots', () => {
	it('accepts every closed execution branch and returns detached deep-frozen values', () => {
		for (const input of validExecutions) {
			const mutable = {
				...input,
				artifact: { ...input.artifact },
				update: { ...input.update },
			}
			const snapshot = clonePluginExecutionSnapshot(mutable)

			expect(snapshot).toEqual(input)
			expect(snapshot).not.toBe(mutable)
			expect(Object.isFrozen(snapshot)).toBe(true)
			expect(Object.isFrozen(snapshot.artifact)).toBe(true)
			expect(Object.isFrozen(snapshot.update)).toBe(true)
		}
		expect(clonePluginExecutionSnapshot(validExecutions.at(-1))).toBe(UNREPORTED_PLUGIN_EXECUTION)
	})

	it.each([
		[
			'static bundle from a module',
			{
				kind: 'static-bundle',
				artifact: { kind: 'built-module' },
				update: { kind: 'deployment' },
			},
		],
		[
			'static catalog from the application bundle',
			{
				kind: 'static-catalog',
				artifact: { kind: 'application-bundle' },
				update: { kind: 'manual' },
			},
		],
		[
			'static catalog with the legacy application-reload update',
			{
				kind: 'static-catalog',
				artifact: { kind: 'source-module' },
				update: { kind: 'application-reload' },
			},
		],
		[
			'dynamic source with entry-only HMR',
			{
				kind: 'dynamic-entry',
				artifact: { kind: 'source-module' },
				update: { kind: 'definition-hmr', scope: 'entry-only' },
			},
		],
		[
			'dynamic build with source-graph HMR',
			{
				kind: 'dynamic-entry',
				artifact: { kind: 'built-module' },
				update: { kind: 'definition-hmr', scope: 'source-graph' },
			},
		],
		[
			'physical module id',
			{
				kind: 'dynamic-entry',
				artifact: { kind: 'built-module', moduleId: 'file:///private/host/plugin.mjs' },
				update: { kind: 'definition-hmr', scope: 'entry-only' },
			},
		],
		[
			'legacy source record',
			{
				kind: 'unreported',
				artifact: { kind: 'unreported' },
				update: { kind: 'unreported' },
				source: '/private/host/plugin.ts',
			},
		],
	] as const)('rejects dishonest or unsafe %s combinations', (_label, input) => {
		expect(() => clonePluginExecutionSnapshot(input)).toThrow(/invalid|unsupported|must be/)
	})

	it('accepts, detaches, and freezes every recent-update outcome', () => {
		const updates = [
			{ outcome: 'applied', phase: null, sequence: 1, durationMs: 0 },
			{
				outcome: 'applied-with-issues',
				phase: 'lifecycle',
				sequence: 2,
				durationMs: 1.25,
			},
			{
				outcome: 'applied-with-issues',
				phase: 'commit',
				sequence: 3,
				durationMs: 1.5,
			},
			{
				outcome: 'retained-previous',
				phase: 'evaluate',
				sequence: 4,
				durationMs: 2,
			},
			{
				outcome: 'retained-previous',
				phase: 'inject',
				sequence: 5,
				durationMs: 3,
			},
			{
				outcome: 'retained-previous',
				phase: 'commit',
				sequence: 6,
				durationMs: 4,
			},
			{
				outcome: 'restored-previous',
				phase: 'application-reload',
				sequence: 7,
				durationMs: 5,
			},
		] as const

		for (const input of updates) {
			const mutable = { ...input }
			const snapshot = clonePluginRecentUpdateSnapshot(mutable)
			expect(snapshot).toEqual(input)
			expect(snapshot).not.toBe(mutable)
			expect(Object.isFrozen(snapshot)).toBe(true)
		}
	})

	it.each([
		{ outcome: 'applied', phase: 'commit', sequence: 1, durationMs: 1 },
		{
			outcome: 'applied-with-lifecycle-issues',
			phase: 'lifecycle',
			sequence: 1,
			durationMs: 1,
		},
		{ outcome: 'applied-with-issues', phase: null, sequence: 1, durationMs: 1 },
		{ outcome: 'applied-with-issues', phase: 'evaluate', sequence: 1, durationMs: 1 },
		{
			outcome: 'retained-previous',
			phase: 'lifecycle',
			sequence: 1,
			durationMs: 1,
		},
		{ outcome: 'restored-previous', phase: 'commit', sequence: 1, durationMs: 1 },
		{ outcome: 'applied', phase: null, sequence: 0, durationMs: 1 },
		{ outcome: 'applied', phase: null, sequence: 1.5, durationMs: 1 },
		{ outcome: 'applied', phase: null, sequence: Number.MAX_SAFE_INTEGER + 1, durationMs: 1 },
		{ outcome: 'applied', phase: null, sequence: 1, durationMs: -1 },
		{ outcome: 'applied', phase: null, sequence: 1, durationMs: Number.POSITIVE_INFINITY },
		{ outcome: 'applied', phase: null, sequence: 1, durationMs: 1, error: '/private/root' },
	])('rejects malformed recent-update snapshot %#', (input) => {
		expect(() => clonePluginRecentUpdateSnapshot(input)).toThrow(/unsupported|must be/)
	})

	it('rejects accessor-backed and non-plain recent-update records', () => {
		const accessorBacked = {
			outcome: 'applied',
			phase: null,
			sequence: 1,
			durationMs: 1,
		}
		Object.defineProperty(accessorBacked, 'durationMs', { get: () => 1, enumerable: true })
		const nonPlain = Object.assign(Object.create({ inherited: true }), {
			outcome: 'restored-previous',
			phase: 'application-reload',
			sequence: 1,
			durationMs: 1,
		})

		expect(() => clonePluginRecentUpdateSnapshot(accessorBacked)).toThrow(/data property/)
		expect(() => clonePluginRecentUpdateSnapshot(nonPlain)).toThrow(/plain object/)
	})
})
