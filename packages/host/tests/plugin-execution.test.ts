import { describe, expect, it } from 'vitest'

import {
	clonePluginExecutionSnapshot,
	clonePluginRecentUpdateSnapshot,
	UNREPORTED_PLUGIN_EXECUTION,
} from '../src/execution'

const validExecutions = [
	...(['fixed', 'source'] as const).map((origin) => ({
		kind: 'native',
		origin,
		artifact: { kind: 'built-module' },
		update: { kind: 'next-start' },
	})),
	{
		kind: 'native',
		origin: 'fixed',
		artifact: { kind: 'application-bundle' },
		update: { kind: 'next-start' },
	},
	...(['source-module', 'built-module'] as const).flatMap((kind) => [
		{ kind: 'vite', origin: 'fixed', artifact: { kind }, update: { kind: 'host-reload' } },
		{ kind: 'vite', origin: 'source', artifact: { kind }, update: { kind: 'definition-hmr' } },
	]),
	UNREPORTED_PLUGIN_EXECUTION,
]

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
		{
			kind: 'native',
			origin: 'source',
			artifact: { kind: 'application-bundle' },
			update: { kind: 'next-start' },
		},
		{
			kind: 'native',
			origin: 'fixed',
			artifact: { kind: 'source-module' },
			update: { kind: 'next-start' },
		},
		{
			kind: 'native',
			origin: 'source',
			artifact: { kind: 'built-module' },
			update: { kind: 'definition-hmr' },
		},
		{
			kind: 'vite',
			origin: 'fixed',
			artifact: { kind: 'built-module' },
			update: { kind: 'definition-hmr' },
		},
		{
			kind: 'vite',
			origin: 'source',
			artifact: { kind: 'built-module' },
			update: { kind: 'definition-hmr', scope: 'entry-only' },
		},
		{
			kind: 'vite',
			origin: 'source',
			artifact: { kind: 'application-bundle' },
			update: { kind: 'definition-hmr' },
		},
		{
			kind: 'unreported',
			origin: 'source',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		},
		{ kind: 'static-catalog', artifact: { kind: 'built-module' }, update: { kind: 'manual' } },
		{
			kind: 'native',
			origin: 'source',
			artifact: { kind: 'built-module', moduleId: '/private/file' },
			update: { kind: 'next-start' },
		},
	])('rejects impossible or obsolete execution facts %#', (input) => {
		expect(() => clonePluginExecutionSnapshot(input)).toThrow(/execution|unsupported|invalid/i)
	})

	it('accepts, detaches, and freezes every recent-update outcome', () => {
		const updates = [
			{
				batch: {
					scope: 'definitions',
					outcome: 'applied',
					phase: null as null,
					sequence: 1,
					durationMs: 0,
				},
				lifecycle: null as null,
			},
			{
				batch: {
					scope: 'definitions',
					outcome: 'applied-with-issues',
					phase: 'lifecycle',
					sequence: 2,
					durationMs: 1.25,
				},
				lifecycle: null as null,
			},
			{
				batch: {
					scope: 'definitions',
					outcome: 'applied-with-issues',
					phase: 'commit',
					sequence: 3,
					durationMs: 1.5,
				},
				lifecycle: null as null,
			},
			{
				batch: {
					scope: 'definitions',
					outcome: 'retained-previous',
					phase: 'evaluate',
					sequence: 4,
					durationMs: 2,
				},
				lifecycle: null as null,
			},
			{
				batch: {
					scope: 'definitions',
					outcome: 'retained-previous',
					phase: 'inject',
					sequence: 5,
					durationMs: 3,
				},
				lifecycle: null as null,
			},
			{
				batch: {
					scope: 'definitions',
					outcome: 'retained-previous',
					phase: 'commit',
					sequence: 6,
					durationMs: 4,
				},
				lifecycle: null as null,
			},
			{
				batch: {
					scope: 'application',
					outcome: 'restored-previous',
					phase: 'application-reload',
					sequence: 7,
					durationMs: 5,
				},
				lifecycle: null as null,
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
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied',
				phase: 'commit',
				sequence: 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied-with-lifecycle-issues',
				phase: 'lifecycle',
				sequence: 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied-with-issues',
				phase: null as null,
				sequence: 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied-with-issues',
				phase: 'evaluate',
				sequence: 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'retained-previous',
				phase: 'lifecycle',
				sequence: 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'restored-previous',
				phase: 'commit',
				sequence: 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied',
				phase: null as null,
				sequence: 0,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied',
				phase: null as null,
				sequence: 1.5,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied',
				phase: null as null,
				sequence: Number.MAX_SAFE_INTEGER + 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied',
				phase: null as null,
				sequence: 1,
				durationMs: -1,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied',
				phase: null as null,
				sequence: 1,
				durationMs: Number.POSITIVE_INFINITY,
			},
			lifecycle: null as null,
		},
		{
			batch: {
				scope: 'definitions',
				outcome: 'applied',
				phase: null as null,
				sequence: 1,
				durationMs: 1,
				error: '/private/root',
			},
			lifecycle: null as null,
		},
	])('rejects malformed recent-update snapshot %#', (input) => {
		expect(() => clonePluginRecentUpdateSnapshot(input)).toThrow(/unsupported|must be/)
	})

	it('rejects accessor-backed and non-plain recent-update records', () => {
		const accessorBacked = {
			batch: {
				scope: 'definitions',
				outcome: 'applied',
				phase: null as null,
				sequence: 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		}
		Object.defineProperty(accessorBacked.batch, 'durationMs', { get: () => 1, enumerable: true })
		const nonPlain = Object.assign(Object.create({ inherited: true }), {
			batch: {
				scope: 'application',
				outcome: 'restored-previous',
				phase: 'application-reload',
				sequence: 1,
				durationMs: 1,
			},
			lifecycle: null as null,
		})

		expect(() => clonePluginRecentUpdateSnapshot(accessorBacked)).toThrow(/data property/)
		expect(() => clonePluginRecentUpdateSnapshot(nonPlain)).toThrow(/plain object/)
	})
})
