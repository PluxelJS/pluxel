import { describe, expect, it } from 'vitest'
import {
	parseAgentToolsAdminSnapshot,
	parseBaseProviderInspectionResult,
	parseConfigResult,
	parseEnsureForkResult,
	parseLogRangeResult,
	parseLogStreamMeta,
	parsePluginDependencyInspectionResult,
	parsePluginDependencyListResult,
	parsePluginDependencyMutationResult,
	parsePluginGroups,
	parsePluginGroupsMutationResult,
	parsePluginLogPolicyMutationResult,
	parsePluginsListOutput,
	parsePluginStatusBatchResult,
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
	reference: '@fixture/management-validation:FixturePlugin',
	route: '/v1/package/FixturePlugin/@fixture/management-validation',
	displayName: 'Fixture Plugin',
	label: { title: 'Fixture Plugin', text: 'Fixture Plugin' },
	rootExportName: 'FixturePlugin',
	isRunning: false,
	isEnabled: true,
	lifecycleStage: 'stopped',
	availability: 'available',
	issues: [],
	source: {
		kind: 'package',
		moduleId: '@fixture/management-validation',
		packageName: '@fixture/management-validation',
		version: '1.0.0',
		tag: null,
	},
} as const

const group = {
	groupId: 'fixture',
	name: 'Fixture',
	nodes: [
		{
			reference: plugin.reference,
			route: plugin.route,
			displayName: plugin.displayName,
			label: plugin.label.text,
			rootExportName: plugin.rootExportName,
			address,
		},
	],
} as const

describe('management protocol validation', () => {
	it('validates and deep-freezes every Level 1 RPC result family', () => {
		const plugins = parsePluginsListOutput({
			plugins: [plugin],
			summary: { total: 1, running: 0, stopped: 1, disabled: 0 },
		})
		expect(plugins.plugins[0]).toEqual(plugin)
		expect(Object.isFrozen(plugins)).toBe(true)
		expect(Object.isFrozen(plugins.plugins)).toBe(true)
		expect(Object.isFrozen(plugins.plugins[0]!.address.definition.entry)).toBe(true)

		expect(parsePluginStatusQueryResult({ ok: true, value: plugin })).toEqual({
			ok: true,
			value: plugin,
		})
		expect(parsePluginGroups([group])).toEqual([group])
		expect(parsePluginGroupsMutationResult({ ok: true, groups: [group] })).toEqual({
			ok: true,
			groups: [group],
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
			parsePluginDependencyListResult({
				ok: true,
				items: [{ address, displayName: 'Fixture Plugin', isRunning: false }],
			}),
		).toMatchObject({ ok: true, items: [{ address }] })
		expect(
			parsePluginDependencyInspectionResult({
				ok: true,
				items: [
					{
						requirement: definition,
						kind: 'plugin',
						effective: address,
						isRunning: false,
						selected: null,
						providerDefault: null,
						options: [
							{
								address,
								displayName: 'Fixture Plugin',
								isRunning: false,
								isEnabled: true,
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
			parseBaseProviderInspectionResult({
				ok: true,
				value: {
					token: definition,
					currentDefault: address,
					isDefault: true,
					providers: [],
				},
			}),
		).toMatchObject({ ok: true, value: { token: definition } })

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
			parsePluginStatusBatchResult({
				ok: true,
				status: 'applied',
				results: [
					{
						address,
						ok: true,
						status: 'applied',
						report,
						isRunning: false,
						isEnabled: true,
						lifecycleStage: 'stopped',
					},
				],
			}),
		).toMatchObject({ ok: true, status: 'applied' })

		const logging = parseVersionedPluginLogPolicySnapshot({
			version: 2,
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

		const agentTools = parseAgentToolsAdminSnapshot({
			revision: 1,
			catalogRevision: 2,
			persistence: 'durable',
			writable: true,
			commands: [
				{
					name: 'fixture.read',
					description: 'Read fixture state',
					behavior: { kind: 'query', world: 'closed' },
				},
			],
			policy: {
				toolsets: [{ id: 'fixture', label: 'Fixture', commandNames: ['fixture.read'] }],
				agents: [{ agentId: 'codex', label: 'Codex', toolsetIds: ['fixture'] }],
			},
		})
		expect(agentTools.commands[0]?.behavior).toEqual({ kind: 'query', world: 'closed' })
		expect(Object.isFrozen(agentTools.policy.toolsets)).toBe(true)
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
			parsePluginDependencyListResult({
				ok: true,
				items: [
					{
						address: { ...address, variant: 'fork', forkId: '../escape' },
						displayName: 'bad',
					},
				],
			}),
		).toThrow(/Plugin fork id/)

		expect(() =>
			parsePluginDependencyInspectionResult({
				ok: true,
				items: [
					{
						index: 0,
						token: definition,
						kind: 'plugin',
						effective: address,
						isRunning: false,
						selected: null,
						providerDefault: null,
						options: [],
					},
				],
			}),
		).toThrow(/unsupported field index/)

		expect(() =>
			parsePluginsListOutput({
				plugins: [plugin],
				summary: { total: 2, running: 0, stopped: 1, disabled: 1 },
			}),
		).toThrow(/inconsistent/)

		expect(() =>
			parsePluginStatusBatchResult({
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

describe('management HTTP payload validation', () => {
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
					msg: 'ready',
					props: { ready: true },
				},
			],
		})
		expect(range.ok && range.lines[0]?.plugin).toBeUndefined()
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
})
