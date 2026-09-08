import {
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { PluginConsumerRequirementState } from '@pluxel/runtime/web'
import { describe, expect, it } from 'vitest'
import {
	buildConsumerOverrideSelection,
	FOLLOW_DEFAULT_VALUE,
} from '../src/app/plugins/detail/usePluginDependencyControls'
import {
	describePluginControl,
	describePluginLifecycleOutcome,
} from '../src/app/plugins/detail/controls/pluginControlModel'
import type { PluginStatusEntry } from '../src/app/plugins/pluginOverview'

const requirement = definition('CacheProvider')
const memory = node('MemoryCache')
const redis = node('RedisCache')
const fork = forkNode('MemoryCache', 'tenant-a')
const unavailable = node('RemovedCache')

describe('plugin detail control presentation', () => {
	it.each([
		['start-failed', '启动失败'],
		['dependency-blocked', '依赖阻塞'],
	] as const)('shows %s instead of waiting to start', (code, label) => {
		expect(
			describePluginControl(
				controlStatus({
					lifecycleState: 'stopped',
					desiredState: 'running',
					issues: [{ id: 'failure', code, message: 'database failed' }],
				}),
			),
		).toMatchObject({ statusLabel: label, statusTone: 'red', statusDescription: 'database failed' })
	})

	it('presents following the default as an explicit implementation choice', () => {
		const selection = buildConsumerOverrideSelection(
			consumerRequirement({ consumerOverride: null, inheritedProvider: memory }),
		)

		expect(selection.value).toBe(FOLLOW_DEFAULT_VALUE)
		expect(selection.data).toEqual([
			{ value: FOLLOW_DEFAULT_VALUE, label: '跟随全局默认 · Memory', disabled: false },
			{
				value: `provider:${pluginNodeIndexKey(memory)}`,
				label: 'Memory',
				disabled: false,
			},
			{
				value: `provider:${pluginNodeIndexKey(redis)}`,
				label: 'Redis（当前不可用）',
				disabled: true,
			},
			{
				value: `provider:${pluginNodeIndexKey(fork)}`,
				label: 'Memory / tenant-a',
				disabled: false,
			},
		])
		expect(selection.providerFor(FOLLOW_DEFAULT_VALUE)).toBeNull()
		expect(selection.providerFor(`provider:${pluginNodeIndexKey(memory)}`)).toEqual(memory)
		expect(selection.providerFor(`provider:${pluginNodeIndexKey(fork)}`)).toEqual(fork)
		expect(selection.providerFor('provider:99')).toBeUndefined()
	})

	it('names the concrete direct provider when following the default resolution', () => {
		const selection = buildConsumerOverrideSelection({
			...consumerRequirement({ consumerOverride: null, inheritedProvider: memory }),
			requirement: memory.definition,
			kind: 'plugin',
			options: [dependencyOption(memory, 'Memory')],
		})

		expect(selection.data[0]).toEqual({
			value: FOLLOW_DEFAULT_VALUE,
			label: '默认实例 · Memory',
			disabled: false,
		})
	})

	it('keeps a current node override selected independently from the provider default', () => {
		const selection = buildConsumerOverrideSelection(
			consumerRequirement({ consumerOverride: fork, inheritedProvider: memory }),
		)

		expect(selection.value).toBe(`provider:${pluginNodeIndexKey(fork)}`)
		expect(selection.providerFor(selection.value)).toEqual(fork)
	})

	it('shows a persisted override that is no longer a selectable candidate', () => {
		const selection = buildConsumerOverrideSelection(
			consumerRequirement({ consumerOverride: unavailable, inheritedProvider: memory }),
		)
		const value = `provider:${pluginNodeIndexKey(unavailable)}`

		expect(selection.value).toBe(value)
		expect(selection.data.at(-1)).toEqual({
			value,
			label: 'RemovedCache（当前不可选）',
			disabled: true,
		})
		expect(selection.providerFor(value)).toEqual(unavailable)
	})

	it('separates auto-start policy, desired state, and observed lifecycle', () => {
		expect(describePluginControl(controlStatus())).toMatchObject({
			primaryLabel: '重启',
			primaryTone: 'blue',
			canStartOrRestart: true,
			canStop: true,
			showStop: true,
			statusLabel: '运行中',
			autoStartActionLabel: '关闭自动启动',
		})
		expect(describePluginControl(controlStatus({ lifecycleState: 'stopped' }))).toMatchObject({
			primaryLabel: '重试启动',
			primaryTone: 'orange',
			canStartOrRestart: true,
			canStop: true,
			showStop: true,
			statusLabel: '等待启动',
		})
		expect(
			describePluginControl(
				controlStatus({
					autoStart: false,
					sessionIntent: 'inherit',
					desiredState: 'stopped',
					activationReason: null,
					lifecycleState: 'stopped',
				}),
			),
		).toMatchObject({
			primaryLabel: '启动',
			primaryTone: 'green',
			canStartOrRestart: true,
			canStop: false,
			showStop: false,
			statusLabel: '已停止',
			autoStartActionLabel: '开启自动启动',
		})

		expect(
			describePluginControl(
				controlStatus({
					availability: 'unavailable',
					autoStart: false,
					sessionIntent: 'run',
					desiredState: 'running',
					activationReason: 'session',
					lifecycleState: 'stopped',
				}),
			),
		).toMatchObject({
			canStartOrRestart: false,
			canStop: true,
			showStop: true,
			canChangeAutoStart: false,
			statusLabel: '不可用',
		})

		expect(describePluginControl(controlStatus(), 'restart')).toMatchObject({
			canStartOrRestart: false,
			canStop: false,
			canChangeAutoStart: true,
		})
	})

	it('surfaces the target lifecycle issue instead of a generic unsettled warning', () => {
		const outcome = describePluginLifecycleOutcome('Discord', 'start', {
			address: memory,
			ok: true,
			status: 'applied',
			control: {
				autoStart: true,
				sessionIntent: 'run',
				desiredState: 'running',
				activationReason: 'session',
				lifecycleState: 'stopped',
			},
			report: applyReport([
				{
					plugin: redis,
					phase: 'start',
					kind: 'start-failed',
					message: 'unrelated failure',
				},
				{
					plugin: memory,
					phase: 'start',
					kind: 'start-failed',
					message: 'Discord failed to start',
					error: {
						name: 'Error',
						message: 'DiscordPlugin requires host config vault: {}',
						partPath: ['accounts'],
					},
				},
			]),
		})

		expect(outcome).toMatchObject({
			title: 'Plugin 启动失败',
			message: 'Discord：DiscordPlugin requires host config vault: {}（PluginPart：accounts）',
			diagnosticText: expect.stringContaining('DiscordPlugin requires host config vault'),
			color: 'red',
		})
	})

	it('keeps the generic warning only when no lifecycle issue explains the final state', () => {
		expect(
			describePluginLifecycleOutcome('Discord', 'restart', {
				address: memory,
				ok: true,
				status: 'applied',
				control: {
					autoStart: true,
					sessionIntent: 'run',
					desiredState: 'running',
					activationReason: 'session',
					lifecycleState: 'stopped',
				},
				report: applyReport([]),
			}),
		).toEqual({
			title: '命令已提交，运行状态仍未收敛',
			message: 'Discord 当前仍未运行，请检查协调问题与依赖状态。',
			color: 'yellow',
		})
	})
})

function applyReport(
	issues: Array<{
		plugin: PluginNodeAddress
		phase: 'start'
		kind: 'start-failed'
		message: string
		error?: { name: string; message: string; partPath?: string[] }
	}>,
) {
	return {
		catalogRevision: 1,
		runtimeStateRevision: 1,
		reconciliation: [],
		core: {
			status: 'committed' as const,
			summary: {
				pluginChanges: {
					added: [],
					replaced: [],
					removed: [],
					restarted: [],
					availabilityChanged: [],
				},
				runtimeUpdate: {},
				lifecycleReport: { ok: issues.length === 0, issues },
			},
		},
	}
}

function consumerRequirement({
	consumerOverride,
	inheritedProvider,
}: {
	consumerOverride: PluginNodeAddress | null
	inheritedProvider: PluginNodeAddress | null
}): PluginConsumerRequirementState {
	return {
		requirement,
		kind: 'abstract',
		consumerOverride,
		inheritedProvider,
		options: [
			dependencyOption(memory, 'Memory'),
			dependencyOption(redis, 'Redis', false),
			dependencyOption(fork, 'Memory'),
		],
	}
}

function dependencyOption(address: PluginNodeAddress, displayName: string, available = true) {
	return {
		address,
		displayName,
		availability: available ? ('available' as const) : ('unavailable' as const),
	}
}

function controlStatus(overrides: Partial<PluginStatusEntry> = {}): PluginStatusEntry {
	return {
		id: 'memory',
		address: memory,
		reference: 'package:@fixture/plugin-detail-controls::MemoryCache',
		route: 'v1/package/MemoryCache/@fixture/plugin-detail-controls',
		displayName: 'Memory',
		label: 'Memory',
		rootExportName: 'MemoryCache',
		availability: 'available',
		issues: [],
		execution: {
			kind: 'unreported',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		},
		recentUpdate: null,
		autoStart: true,
		sessionIntent: 'inherit',
		desiredState: 'running',
		activationReason: 'auto-start',
		lifecycleState: 'running',
		...overrides,
	}
}

function definition(exportName: string): PluginDefinitionAddress {
	return {
		entry: { kind: 'package-root', packageName: '@fixture/plugin-detail-controls' },
		exportName,
	}
}

function node(exportName: string): PluginNodeAddress {
	return { definition: definition(exportName), variant: 'default' }
}

function forkNode(exportName: string, forkId: string): PluginNodeAddress {
	return { definition: definition(exportName), variant: 'fork', forkId }
}
