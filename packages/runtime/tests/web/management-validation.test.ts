import { describe, expect, it } from 'vitest'
import {
	parseConfigResult,
	parseEnsureForkResult,
	parseLogRangeResult,
	parseLogStreamMeta,
	parsePluginConsumerRequirementsInspectionResult,
	parsePluginDependencyMutationResult,
	parsePluginProviderPolicyInspectionResult,
	parsePluginCatalogLayoutMutationResult,
	parsePluginCatalogSnapshot,
	parsePluginLogPolicyMutationResult,
	parsePluginControlBatchResult,
	parsePluginStatusQueryResult,
	parseRemoveForkResult,
	parseRuntimeLogStreamsIndex,
	parseSecurityAuditEvents,
	parseSecurityOverview,
	parseVaultAdminState,
	parseVaultKeyPair,
	parseVaultPublicKeyResult,
	parseVersionedPluginLogPolicySnapshot,
} from '../../src/web/management-validation'
import { RuntimeProtocolValidationError } from '../../src/web/validation'
import { prepareRuntimeLogRangeForRpc } from '../../src/services/management/log-transport'
import { RUNTIME_SESSION_RPC_PAYLOAD_BUDGET_BYTES } from '../../src/web/session/limits'

const address = {
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/management-validation' },
		exportName: 'FixturePlugin',
	},
	variant: 'default',
} as const

const definition = address.definition

const report = {
	catalogRevision: 3,
	runtimeStateRevision: 5,
	reconciliation: [],
	core: { status: 'unchanged' },
} as const

const plugin = {
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
		kind: 'static-bundle',
		artifact: { kind: 'application-bundle' },
		update: { kind: 'deployment' },
	},
	recentUpdate: null,
} as const

const section = {
	sectionId: 'package:@fixture/management-validation',
	name: 'Fixture',
	basis: { kind: 'manual' },
	nodes: [address],
} as const

describe('management protocol validation', () => {
	it('validates and deep-freezes every Level 1 RPC result family', () => {
		const catalog = parsePluginCatalogSnapshot({
			plugins: [plugin],
			sections: [section],
			summary: { total: 1, running: 0, stopped: 1, autoStart: 1 },
		})
		expect(catalog.plugins[0]).toEqual(plugin)
		expect(catalog.sections).toEqual([section])
		expect(Object.isFrozen(catalog)).toBe(true)
		expect(Object.isFrozen(catalog.plugins)).toBe(true)
		expect(Object.isFrozen(catalog.plugins[0]!.address.definition.entry)).toBe(true)

		expect(parsePluginStatusQueryResult({ ok: true, value: plugin })).toEqual({
			ok: true,
			value: plugin,
		})
		expect(parsePluginCatalogLayoutMutationResult({ ok: true, sections: [section] })).toEqual({
			ok: true,
			sections: [section],
		})

		const config = parseConfigResult({
			ok: true,
			saved: true,
			application: 'applied',
			desiredRevision: 4,
			appliedRevision: 4,
			config: { nested: { enabled: true } },
			report,
		})
		expect(config).toMatchObject({ ok: true, saved: true, application: 'applied' })
		expect(Object.isFrozen((Reflect.get(config, 'config') as { nested: unknown }).nested)).toBe(
			true,
		)

		expect(
			parsePluginConsumerRequirementsInspectionResult({
				ok: true,
				items: [
					{
						requirement: definition,
						kind: 'plugin',
						consumerOverride: null,
						inheritedProvider: address,
						options: [
							{
								address,
								displayName: 'Fixture Plugin',
								availability: 'available',
							},
						],
					},
				],
			}),
		).toMatchObject({ ok: true, items: [{ requirement: definition }] })
		expect(parsePluginDependencyMutationResult({ ok: true, status: 'applied', report })).toEqual({
			ok: true,
			status: 'applied',
			report,
		})
		expect(
			parsePluginDependencyMutationResult({
				ok: false,
				code: 'provider_policy_unavailable',
				state: 'unchanged',
				error: 'not a provider policy owner',
			}),
		).toMatchObject({ ok: false, code: 'provider_policy_unavailable', state: 'unchanged' })
		expect(
			parsePluginProviderPolicyInspectionResult({
				ok: true,
				value: {
					token: definition,
					defaultProvider: address,
					policyOwnerIsDefault: true,
					options: [],
				},
			}),
		).toMatchObject({ ok: true, value: { token: definition } })
		expect(
			parsePluginProviderPolicyInspectionResult({
				ok: false,
				code: 'provider_policy_unavailable',
				state: 'unchanged',
				error: 'owner unavailable',
			}),
		).toMatchObject({ ok: false, code: 'provider_policy_unavailable', state: 'unchanged' })

		expect(parseEnsureForkResult({ ok: true, status: 'deferred', fork: address, report })).toEqual({
			ok: true,
			status: 'deferred',
			fork: address,
			report,
		})
		expect(parseRemoveForkResult({ ok: true, status: 'already-absent', fork: address })).toEqual({
			ok: true,
			status: 'already-absent',
			fork: address,
		})
		expect(
			parseRemoveForkResult({
				ok: false,
				code: 'persistence_failed',
				state: 'stopped-retained',
				fork: address,
				error: 'metadata cleanup failed',
			}),
		).toMatchObject({ ok: false, code: 'persistence_failed', state: 'stopped-retained' })
		expect(
			parsePluginControlBatchResult({
				ok: true,
				status: 'applied',
				results: [
					{
						address,
						ok: true,
						status: 'applied',
						report,
						control: {
							autoStart: true,
							sessionIntent: 'inherit',
							desiredState: 'running',
							activationReason: 'auto-start',
							lifecycleState: 'stopped',
						},
					},
				],
			}),
		).toMatchObject({ ok: true, status: 'applied' })
		expect(
			parsePluginControlBatchResult({
				ok: false,
				status: 'rejected',
				results: [
					{
						address,
						ok: false,
						code: 'start_unavailable',
						state: 'unchanged',
						error: 'Plugin node is unavailable',
					},
				],
			}),
		).toMatchObject({
			ok: false,
			status: 'rejected',
			results: [{ code: 'start_unavailable', state: 'unchanged' }],
		})

		const logging = parseVersionedPluginLogPolicySnapshot({
			version: 3,
			defaultLevel: 'info',
			overrides: [{ owner: address, level: 'off' }],
			revision: 2,
			persistence: 'clean',
		})
		expect(logging.overrides).toEqual([{ owner: address, level: 'off' }])
		expect(Object.isFrozen(logging.overrides)).toBe(true)
		expect(parsePluginLogPolicyMutationResult({ revision: 3, persistence: 'dirty' })).toEqual({
			revision: 3,
			persistence: 'dirty',
		})
	})

	it('validates portable execution diagnostics without exposing physical module identity', () => {
		const result = parsePluginStatusQueryResult({
			ok: true,
			value: {
				...plugin,
				execution: {
					kind: 'dynamic-entry',
					artifact: { kind: 'built-module' },
					update: { kind: 'definition-hmr', scope: 'entry-only' },
				},
				recentUpdate: {
					batch: {
						scope: 'application',
						outcome: 'restored-previous',
						phase: 'application-reload',
						sequence: 7,
						durationMs: 4.5,
					},
					lifecycle: null,
				},
			},
		})
		expect(result).toMatchObject({
			ok: true,
			value: {
				execution: {
					kind: 'dynamic-entry',
					artifact: { kind: 'built-module' },
					update: { kind: 'definition-hmr', scope: 'entry-only' },
				},
				recentUpdate: {
					batch: {
						scope: 'application',
						outcome: 'restored-previous',
						phase: 'application-reload',
					},
					lifecycle: null,
				},
			},
		})
		if (!result.ok || !result.value) throw new Error('expected one Plugin status')
		expect(Object.isFrozen(result.value.execution)).toBe(true)
		expect(Object.isFrozen(result.value.execution.artifact)).toBe(true)
		expect(Object.isFrozen(result.value.execution.update)).toBe(true)
		expect(Object.isFrozen(result.value.recentUpdate)).toBe(true)
		const serialized = JSON.stringify(result.value)
		expect(serialized).not.toContain('moduleId')
		expect(serialized).not.toContain('file://')
		expect(serialized).not.toContain('/@fs/')
		expect(serialized).not.toContain('/private/host')

		expect(() =>
			parsePluginStatusQueryResult({
				ok: true,
				value: {
					...plugin,
					execution: {
						kind: 'dynamic-entry',
						artifact: {
							kind: 'built-module',
							moduleId: 'file:///private/host/plugin.mjs',
						},
						update: { kind: 'definition-hmr', scope: 'entry-only' },
					},
				},
			}),
		).toThrow(/unsupported field moduleId/)
		expect(() =>
			parsePluginStatusQueryResult({
				ok: true,
				value: {
					...plugin,
					execution: {
						kind: 'dynamic-entry',
						artifact: { kind: 'source-module' },
						update: { kind: 'definition-hmr', scope: 'entry-only' },
					},
				},
			}),
		).toThrow(/invalid execution, artifact, and update combination/)
		expect(() =>
			parsePluginStatusQueryResult({
				ok: true,
				value: {
					...plugin,
					recentUpdate: {
						batch: {
							scope: 'definitions',
							outcome: 'applied',
							phase: null,
							sequence: 0,
							durationMs: -1,
						},
						lifecycle: null,
					},
				},
			}),
		).toThrow(/sequence must be a positive safe integer/)
		expect(() =>
			parsePluginStatusQueryResult({
				ok: true,
				value: {
					...plugin,
					recentUpdate: {
						batch: {
							scope: 'definitions',
							outcome: 'applied-with-lifecycle-issues',
							phase: 'lifecycle',
							sequence: 1,
							durationMs: 1,
						},
						lifecycle: null,
					},
				},
			}),
		).toThrow(/outcome must be one of/)
		expect(() =>
			parsePluginStatusQueryResult({
				ok: true,
				value: {
					...plugin,
					recentUpdate: {
						batch: {
							scope: 'application',
							outcome: 'restored-previous',
							phase: 'commit',
							sequence: 1,
							durationMs: 1,
						},
						lifecycle: null,
					},
				},
			}),
		).toThrow(/phase must be application-reload/)
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

	it('rejects open shapes, dangerous fields, malformed addresses, and dishonest states', () => {
		expect(() =>
			parsePluginStatusQueryResult({
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				error: 'bad input',
				retryable: true,
			}),
		).toThrow(/unsupported field retryable/)

		const dangerous = Object.create(null) as Record<string, unknown>
		dangerous.ok = true
		dangerous.saved = false
		dangerous.application = 'applied'
		dangerous.desiredRevision = 0
		dangerous.appliedRevision = 0
		dangerous.config = Object.assign(Object.create(null), { constructor: 'poison' })
		dangerous.defaults = {}
		expect(() => parseConfigResult(dangerous)).toThrow(/reserved field constructor/)

		expect(() =>
			parsePluginConsumerRequirementsInspectionResult({
				ok: true,
				items: [
					{
						requirement: definition,
						index: 0,
						token: definition,
						kind: 'plugin',
						consumerOverride: null,
						inheritedProvider: null,
						options: [],
					},
				],
			}),
		).toThrow(/unsupported field index/)

		expect(() =>
			parsePluginConsumerRequirementsInspectionResult({
				ok: true,
				items: [
					{
						requirement: definition,
						kind: 'plugin',
						consumerOverride: null,
						inheritedProvider: null,
						options: [
							{
								address,
								displayName: 'Fixture Plugin',
								availability: 'available',
								lifecycleState: 'stopped',
							},
						],
					},
				],
			}),
		).toThrow(/unsupported field lifecycleState/)

		expect(() =>
			parsePluginConsumerRequirementsInspectionResult({
				ok: true,
				items: [
					{
						requirement: definition,
						kind: 'plugin',
						consumerOverride: null,
						selected: null,
						inheritedProvider: null,
						options: [],
					},
				],
			}),
		).toThrow(/unsupported field selected/)

		expect(() =>
			parseEnsureForkResult({
				ok: true,
				status: 'saved-not-applied',
				fork: address,
				report,
			}),
		).toThrow(/applied, deferred/)

		expect(() =>
			parseRemoveForkResult({
				ok: false,
				code: 'persistence_failed',
				state: 'disabled-retained',
				fork: address,
				error: 'legacy state',
			}),
		).toThrow(/stopped-retained/)

		expect(() =>
			parsePluginCatalogSnapshot({
				plugins: [plugin],
				sections: [section],
				summary: { total: 2, running: 0, stopped: 1, autoStart: 1 },
			}),
		).toThrow(/inconsistent/)

		expect(() =>
			parsePluginCatalogSnapshot({
				plugins: [plugin, plugin],
				sections: [section],
				summary: { total: 2, running: 0, stopped: 2, autoStart: 2 },
			}),
		).toThrow(/duplicate Plugin node/)

		expect(() =>
			parsePluginCatalogLayoutMutationResult({
				ok: true,
				sections: [section, section],
			}),
		).toThrow(/duplicate section ids/)

		expect(() =>
			parsePluginCatalogLayoutMutationResult({
				ok: true,
				sections: [
					section,
					{
						sectionId: 'source:app/src/other',
						name: 'other',
						basis: { kind: 'manual' },
						nodes: [{ definition, variant: 'fork', forkId: 'other' }],
					},
				],
			}),
		).toThrow(/definition family across sections/)

		expect(() =>
			parsePluginControlBatchResult({
				ok: false,
				status: 'partially-applied',
				results: [
					{
						address,
						ok: false,
						code: 'graph_rejected',
						state: 'unchanged',
						error: 'rejected',
					},
				],
			}),
		).toThrow(/successes and failures/)
	})

	it('enforces portable-data budgets before interpreting a result', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(() => parseConfigResult(cyclic)).toThrow(RuntimeProtocolValidationError)

		expect(() =>
			parseConfigResult({
				ok: true,
				saved: false,
				application: 'applied',
				desiredRevision: 0,
				appliedRevision: 0,
				config: { items: Array.from({ length: 10_001 }, () => null) },
				defaults: {},
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
			namespaces: [{ namespace: 'fixture', kvKeys: 1, docDocuments: 2, blobs: 3 }],
		} as const
		const overview = parseSecurityOverview({
			adminAccess: {
				policy: 'provider-or-local-recovery',
				provider: null,
			},
			vault: { enabled: true, state: vault },
		})
		expect(overview.vault).toEqual({ enabled: true, state: vault })
		expect(
			parseSecurityOverview({
				adminAccess: {
					policy: 'provider-or-local-recovery',
					provider: {
						id: '@pluxel/auth',
						label: 'Pluxel Auth',
						method: 'password-totp',
						ready: true,
					},
				},
				vault: { enabled: false },
			}).vault,
		).toEqual({ enabled: false })
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
