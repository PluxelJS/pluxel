import { describe, expect, it, vi } from 'vitest'
import type {
	PluginStatusSnapshot,
	PluginControlMutationResult,
	PluginControlSnapshot,
} from '../../../src/management/web/protocol'
import { summarizePluginControlBatch } from '../../../src/management/web/control-batch'
import {
	parseConfigResult,
	parseConfigState,
	parseLogRangeResult,
	parseLogStreamMeta,
	parsePluginCatalogLayoutMutationResult,
	parsePluginCatalogSnapshot,
	parsePluginControlBatchResult,
	parsePluginStatusQueryResult,
	parseRuntimeLogStreamsIndex,
	parseSecurityAuditEvents,
	parseSecurityOverview,
	parseVaultAdminState,
	parseVaultKeyPair,
	parseVaultPublicKeyResult,
} from '../../../src/management/web/management-validation.ts'
import { RuntimeProtocolValidationError } from '../../../src/management/web/validation.ts'
import { prepareRuntimeLogRangeForRpc } from '../../../src/management/services/management/log-transport.ts'
import { RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES } from '../../../src/management/web/session/limits.ts'

const catalogPolicy = {
	mode: {
		autoStart: 'declared-first',
		forks: 'declared-first',
		providerDefaults: 'declared-first',
		dependencyOverrides: 'declared-first',
	},
	nodeModes: [],
	selections: [],
	providerDefaultsSource: 'default',
	providerDefaultsShadowed: false,
} as const

const address = {
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/management-validation' },
		exportName: 'FixturePlugin',
	},
	variant: 'default',
} as const

const definition = address.definition
const fork = { definition, variant: 'fork', forkId: 'east' } as const

const report = {
	catalogRevision: 3,
	runtimeStateRevision: 5,
	reconciliation: [],
	core: { status: 'unchanged' },
	persistence: { status: 'unchanged' },
	writtenFields: [],
} as const

const plugin: PluginStatusSnapshot = {
	address,
	reference: 'package:@fixture/management-validation::FixturePlugin',
	route: '/v1/package/FixturePlugin/@fixture/management-validation',
	displayName: 'Fixture Plugin',
	label: { title: 'Fixture Plugin', text: 'Fixture Plugin' },
	rootExportName: 'FixturePlugin',
	autoStart: true,
	sessionIntent: 'inherit',
	desiredState: 'running',
	activationReason: 'auto-start',
	lifecycleState: 'stopped',
	availability: 'available',
	issues: [],
	execution: {
		kind: 'native',
		origin: 'fixed',
		artifact: { kind: 'application-bundle' },
		update: { kind: 'next-start' },
	},
	recentUpdate: null,
} as const

const section = {
	sectionId: 'package:@fixture/management-validation',
	name: 'Fixture',
	basis: { kind: 'manual' },
	nodes: [address],
} as const
const catalog = {
	plugins: [plugin],
	sections: [section],
	statePolicy: { ...catalogPolicy, readonly: false, managedRevision: 'policy:test:0' },
	summary: { total: 1, running: 0, stopped: 1, autoStart: 1 },
}

describe('management protocol validation', () => {
	it('preserves control declaration diagnostics without changing runtime availability or lifecycle', () => {
		for (const code of ['control_analysis_failed', 'control_source_changed'] as const) {
			const issue = {
				id: `control:${code}`,
				code,
				message: 'Plugin declaration input could not be matched',
			}
			const value = { ...plugin, lifecycleState: 'running', issues: [issue] }
			expect(parsePluginStatusQueryResult({ ok: true, value })).toEqual({ ok: true, value })
		}
	})

	it('validates config write policy without invoking accessors', () => {
		expect(parseConfigState({ readonly: true })).toEqual({ readonly: true })
		const getter = vi.fn(() => false)
		const borrowed = Object.defineProperty({}, 'readonly', { enumerable: true, get: getter })
		expect(() => parseConfigState(borrowed)).toThrow(/data property/)
		expect(getter).not.toHaveBeenCalled()
		expect(() => parseConfigState({ readonly: 'yes' })).toThrow(RuntimeProtocolValidationError)
	})

	it('preserves uncertain batches and rejects summaries that contradict individual results', () => {
		const control: PluginControlSnapshot = {
			autoStart: false,
			sessionIntent: 'inherit',
			desiredState: 'stopped',
			activationReason: null,
			lifecycleState: 'stopped',
		} as const
		const applied = { address, ok: true, status: 'applied', report, control } as const
		const rejected = {
			address,
			ok: false,
			code: 'start_unavailable',
			state: 'unchanged',
			error: 'unavailable',
		} as const
		const uncertain = {
			address,
			ok: false,
			code: 'persistence_failed',
			state: 'unknown',
			error: 'unconfirmed write',
		} as const
		const issue = {
			address,
			ok: false,
			code: 'lifecycle_failed',
			status: 'applied-with-issues',
			error: 'missing consumer',
			control,
			report: {
				...report,
				reconciliation: [
					{ kind: 'consumer_unavailable', consumer: address, message: 'missing consumer' },
				],
			},
		} as const
		const cases: readonly [PluginControlMutationResult[], boolean, string][] = [
			[[applied], true, 'applied'],
			[[issue], false, 'applied-with-issues'],
			[[applied, rejected], false, 'partially-applied'],
			[[rejected], false, 'rejected'],
			[[applied, issue, rejected, uncertain], false, 'unknown'],
		]
		for (const [results, ok, status] of cases) {
			const batch = { results, ok, status }
			expect(summarizePluginControlBatch(results)).toEqual(batch)
			expect(parsePluginControlBatchResult(batch)).toEqual(batch)
		}
		const uncertainBatch = {
			ok: false,
			status: 'unknown',
			results: [applied, uncertain],
			managedRevision: 'policy:test:7',
		}
		expect(parsePluginControlBatchResult(uncertainBatch)).toEqual(uncertainBatch)
		expect(() =>
			parsePluginControlBatchResult({ ...uncertainBatch, status: 'partially-applied' }),
		).toThrow(RuntimeProtocolValidationError)
		expect(() => parsePluginControlBatchResult({ ...uncertainBatch, ok: true })).toThrow(
			RuntimeProtocolValidationError,
		)
	})

	it('keeps update diagnostics portable and rejects impossible execution metadata', () => {
		const execution = {
			kind: 'vite',
			origin: 'source',
			artifact: { kind: 'built-module' },
			update: { kind: 'definition-hmr' },
		}
		const batch = {
			scope: 'application',
			outcome: 'restored-previous',
			phase: 'application-reload',
			sequence: 7,
			durationMs: 4.5,
		}
		const recentUpdate = { batch, lifecycle: null as null }
		const value = { ...plugin, execution, recentUpdate }
		expect(parsePluginStatusQueryResult({ ok: true, value })).toEqual({ ok: true, value })

		const privateArtifact = { ...execution.artifact, moduleId: 'file:///private/plugin.mjs' }
		const privateStatus = { ...value, execution: { ...execution, artifact: privateArtifact } }
		expect(() => parsePluginStatusQueryResult({ ok: true, value: privateStatus })).toThrow(
			/unsupported field moduleId/,
		)
		const wrongRuntime = { ...value, execution: { ...execution, kind: 'native' } }
		expect(() => parsePluginStatusQueryResult({ ok: true, value: wrongRuntime })).toThrow(
			/invalid execution, artifact, and update combination/,
		)
		const wrongPhase = {
			...value,
			recentUpdate: { ...recentUpdate, batch: { ...batch, phase: 'commit' } },
		}
		expect(() => parsePluginStatusQueryResult({ ok: true, value: wrongPhase })).toThrow(
			/phase must be application-reload/,
		)
	})

	it('rejects a display reference that contradicts the canonical Plugin address', () => {
		expect(() =>
			parsePluginStatusQueryResult({
				ok: true,
				value: {
					...plugin,
					reference: '@fixture/other:FixturePlugin',
				},
			}),
		).toThrow(/reference must match its canonical address/)
	})

	it('rejects catalog snapshots with contradictory totals or duplicate identities', () => {
		expect(() =>
			parsePluginCatalogSnapshot({
				...catalog,
				summary: { ...catalog.summary, total: 2 },
			}),
		).toThrow(/inconsistent/)
		expect(() =>
			parsePluginCatalogSnapshot({
				...catalog,
				plugins: [plugin, plugin],
				summary: { total: 2, running: 0, stopped: 2, autoStart: 2 },
			}),
		).toThrow(/duplicate Plugin node/)
		const second = { ...section, sectionId: 'source:app/src/other', nodes: [fork] }
		expect(() =>
			parsePluginCatalogLayoutMutationResult({ ok: true, sections: [section, second] }),
		).toThrow(/definition family across sections/)
	})

	it('requires exact, non-duplicate policy targets and matching modes', () => {
		const { statePolicy } = catalog
		const choice = {
			target: { field: 'autoStart', node: address },
			mode: 'declared-first',
			source: 'declared',
			shadowed: true,
		}
		expect(
			parsePluginCatalogSnapshot({
				...catalog,
				statePolicy: { ...statePolicy, selections: [choice] },
			}).statePolicy.selections,
		).toEqual([choice])
		for (const invalid of [
			{ ...statePolicy, mode: 'readwrite' },
			{ ...statePolicy, selections: [choice, choice] },
			{ ...statePolicy, selections: [{ ...choice, mode: 'saved-first' }] },
			{ ...statePolicy, selections: [{ ...choice, target: { ...choice.target, field: 'forks' } }] },
		]) {
			expect(() => parsePluginCatalogSnapshot({ ...catalog, statePolicy: invalid })).toThrow(
				/statePolicy/,
			)
		}
	})

	it('rejects accessors, sparse arrays and nested capabilities without executing getters', () => {
		const getter = vi.fn(() => plugin)
		const items = [plugin]
		Object.defineProperty(items, '0', { enumerable: true, get: getter })
		expect(() => parsePluginCatalogSnapshot({ ...catalog, plugins: items })).toThrow(
			/data property/,
		)
		expect(getter).not.toHaveBeenCalled()
		expect(() => parsePluginCatalogSnapshot({ ...catalog, plugins: Array(1) })).toThrow(
			/dense array/,
		)
		expect(() =>
			parsePluginCatalogSnapshot({
				...catalog,
				plugins: [{ ...plugin, extra: { constructor: null } }],
			}),
		).toThrow(/reserved field/)
	})

	it('detaches opaque configuration leaves without freezing or retaining the caller tree', () => {
		const input = {
			ok: true,
			persistence: { status: 'unchanged' },
			readonly: false,
			mode: 'declared-first',
			managedInput: null as null,
			effectiveInput: {},
			sources: [] as const,
			shadowedPaths: [] as const,
			managedRevision: 'test:config:0',
			application: 'applied',
			desiredRevision: 0,
			appliedRevision: 0,
			config: { nested: [{ value: 'before' }] },
		}
		const parsed = parseConfigResult(input)
		input.config.nested[0]!.value = 'after'
		expect(parsed).toMatchObject({
			config: { nested: [{ value: 'before' }] },
		})
		expect(Object.isFrozen(input.config)).toBe(false)
		if (!parsed.ok) throw new Error('Expected a configuration read')
		expect(Object.isFrozen(parsed.config.nested)).toBe(true)
	})

	it('enforces portable-data budgets before interpreting a result', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(() => parseConfigResult(cyclic)).toThrow(RuntimeProtocolValidationError)

		expect(() =>
			parseConfigResult({
				ok: true,
				persistence: { status: 'unchanged' },
				readonly: false,
				mode: 'declared-first',
				managedInput: null as null,
				effectiveInput: {},
				sources: [] as const,
				shadowedPaths: [] as const,
				managedRevision: 'test:config:0',
				application: 'applied',
				desiredRevision: 0,
				appliedRevision: 0,
				config: { items: Array.from({ length: 10_001 }, (): null => null) },
			}),
		).toThrow(/10000 items/)
	})
})

describe("management Cap'n Web DTO validation", () => {
	it('validates logs and security payloads without retaining mutable wire objects', () => {
		const meta = {
			streamId: 'runtime',
			bootId: 'boot-1',
			epoch: 1,
			headSeq: '1',
			tailSeq: '2',
			nextSeq: '3',
			count: 2,
			retention: { windowLines: 1_000 },
		}
		expect(parseLogStreamMeta(meta)).toEqual(meta)
		expect(parseRuntimeLogStreamsIndex({ streams: [meta] })).toEqual({ streams: [meta] })
		const range = parseLogRangeResult({
			ok: true,
			streamId: 'runtime',
			epoch: 1,
			fromSeq: '1',
			nextSeq: '2',
			lines: [
				{
					streamId: 'runtime',
					epoch: 1,
					seq: '1',
					ts: 1_700_000_000_000,
					level: 'info',
					category: ['pluxel', 'runtime'],
					plugin: address,
					pluginReference: 'package:@fixture/management-validation::FixturePlugin',
					pluginLabel: 'Fixture',
					msg: 'ready',
					props: { ready: true },
				},
			],
		})
		expect(range.ok && range.lines[0]).toMatchObject({
			plugin: address,
			pluginReference: 'package:@fixture/management-validation::FixturePlugin',
			pluginLabel: 'Fixture',
		})
		expect(Object.isFrozen(range)).toBe(true)
		expect(
			Object.isFrozen((Reflect.get(range, 'lines') as Array<{ props: unknown }>)[0]?.props),
		).toBe(true)

		const vault = {
			present: true,
			unlocked: true,
			unlockedBy: 'host',
			deploy: { env: 'PLUXEL_VAULT_DEPLOY_IDENTITY', identityPresent: false, recipients: [] },
			hostIdentityPresent: true,
			namespaces: [{ namespace: 'fixture', kvKeys: 1, blobs: 3 }],
		} as const
		const overview = parseSecurityOverview({
			adminAccess: {
				policy: 'provider-or-local-recovery',
				provider: null,
			},
			vault: { enabled: true, state: vault },
		})
		expect(overview.vault).toEqual({ enabled: true, state: vault })
		expect(() => parseSecurityOverview({ ...overview, vault: { enabled: false } })).toThrow(
			'vault.enabled must be true',
		)
		expect(
			parseSecurityOverview({
				adminAccess: {
					policy: 'provider-or-local-recovery',
					provider: {
						id: '@pluxel/plugin-auth',
						label: 'Pluxel Auth',
						method: 'password-totp',
						ready: true,
					},
				},
				vault: { enabled: true, state: vault },
			}).vault,
		).toEqual({ enabled: true, state: vault })
		expect(parseVaultAdminState(vault)).toEqual(vault)
		expect(parseVaultPublicKeyResult({ publicKey: 'age1public' })).toEqual({
			publicKey: 'age1public',
		})
		expect(
			parseVaultKeyPair({ publicKey: 'age1public', privateKey: 'AGE-SECRET', envName: 'KEY' }),
		).toEqual({ publicKey: 'age1public', privateKey: 'AGE-SECRET', envName: 'KEY' })
		expect(
			parseSecurityAuditEvents([
				{
					id: 'security:1',
					at: 1_700_000_000_000,
					area: 'vault',
					action: 'unlock',
					status: 'success',
					message: 'unlocked',
				},
			]),
		).toHaveLength(1)
	})

	it('rejects invalid uint64 values and extra security fields', () => {
		expect(() =>
			parseLogStreamMeta({
				streamId: 'runtime',
				bootId: 'boot-1',
				epoch: 1,
				headSeq: '18446744073709551616',
				tailSeq: '2',
				nextSeq: '3',
				count: 2,
				retention: { windowLines: 1_000 },
			}),
		).toThrow(/exceeds uint64/)

		expect(() =>
			parseVaultPublicKeyResult({ publicKey: 'age1public', privateKey: 'secret' }),
		).toThrow(/unsupported field privateKey/)
	})

	it('paginates log ranges below the physical WebSocket message budget', () => {
		const largeProps = Object.fromEntries(
			Array.from({ length: 80 }, (_, index) => [`field${index}`, 'x'.repeat(4_000)]),
		)
		const result = prepareRuntimeLogRangeForRpc({
			ok: true,
			streamId: 'default',
			epoch: 1,
			fromSeq: '1',
			nextSeq: '81',
			lines: Array.from({ length: 80 }, (_, index) => ({
				streamId: 'default',
				epoch: 1,
				seq: String(index + 1),
				ts: 1_700_000_000_000 + index,
				level: 'info',
				category: ['pluxel', 'runtime'],
				msg: `line-${index + 1}`,
				...(index === 0
					? { plugin: undefined, props: largeProps }
					: { props: { index, payload: 'x'.repeat(4_000) } }),
			})),
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
			RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES,
		)
		expect(result.lines.length).toBeLessThan(80)
		expect(result.lines[0]?.props).toEqual({ rpcPayloadTruncated: true })
		expect(Object.hasOwn(result.lines[0]!, 'plugin')).toBe(false)
		expect(result.nextSeq).toBe(String(Number(result.lines.at(-1)!.seq) + 1))
	})

	it('preserves in-budget log text and deterministically compacts an oversized single line', () => {
		const preservedMessage = 'p'.repeat(10_000)
		const preserved = prepareRuntimeLogRangeForRpc({
			ok: true,
			streamId: 'default',
			epoch: 1,
			fromSeq: '1',
			nextSeq: '2',
			lines: [
				{
					streamId: 'default',
					epoch: 1,
					seq: '1',
					ts: 1_700_000_000_000,
					level: 'info',
					category: ['pluxel', 'runtime'],
					msg: preservedMessage,
				},
			],
		})
		expect(preserved.ok && preserved.lines[0]?.msg).toBe(preservedMessage)
		expect(preserved.ok && preserved.lines[0]?.props).toBeUndefined()

		const oversized = prepareRuntimeLogRangeForRpc({
			ok: true,
			streamId: 'default',
			epoch: 1,
			fromSeq: '1',
			nextSeq: '2',
			lines: [
				{
					streamId: 'default',
					epoch: 1,
					seq: '1',
					ts: 1_700_000_000_000,
					level: 'error',
					category: ['pluxel', 'runtime'],
					msg: '\0'.repeat(RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES),
					error: { stack: '\0'.repeat(RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES) },
				},
			],
		})

		expect(oversized.ok).toBe(true)
		if (!oversized.ok) return
		expect(oversized.lines).toHaveLength(1)
		expect(oversized.lines[0]?.props).toEqual({ rpcPayloadTruncated: true })
		expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeLessThanOrEqual(
			RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES,
		)
	})
})
