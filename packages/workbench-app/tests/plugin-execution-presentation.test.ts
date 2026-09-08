import type { PluginEntryAddress, PluginNodeAddress } from '@pluxel/core'
import type { PluginExecutionSnapshot } from '@pluxel/runtime/web'
import { describe, expect, it } from 'vitest'
import {
	describePluginDefinition,
	describePluginExecution,
	describePluginRecentUpdate,
	describePluginRuntime,
} from '../src/app/plugins/pluginExecutionPresentation'

const packageEntry = {
	kind: 'package-root',
	packageName: '@fixture/tools',
} satisfies PluginEntryAddress
const sourceEntry = {
	kind: 'source-entry',
	sourceSpace: 'workspace',
	path: 'plugins/tools.ts',
} satisfies PluginEntryAddress

describe('plugin execution presentation', () => {
	it('keeps historical artifact failure diagnostics on its batch without marking the running plugin as stopped', () => {
		const result = describePluginRecentUpdate({
			batch: {
				scope: 'definitions',
				outcome: 'retained-previous',
				phase: 'artifacts',
				sequence: 3,
				durationMs: 42,
				error: {
					message: 'Invalid renderer syntax',
					file: 'new-renderer.tsx',
					importChain: ['workbench.ts', 'new-renderer.tsx'],
				},
			},
			lifecycle: null,
		})
		expect(result).toMatchObject({
			label: '更新失败 · 已保留上一版本',
			tone: 'yellow',
			meta: '#3 · 42 ms · 界面产物准备阶段',
			details: [
				'批次错误：Invalid renderer syntax',
				'失败文件：new-renderer.tsx',
				'导入链：workbench.ts → new-renderer.tsx',
			],
		})
		expect(result.searchTerms.join(' ')).toContain('Invalid renderer syntax')
	})
	it.each<{
		execution: PluginExecutionSnapshot
		badge: string
	}>([
		{
			execution: {
				kind: 'static-bundle',
				artifact: { kind: 'application-bundle' },
				update: { kind: 'deployment' },
			},
			badge: '部署更新',
		},
		{
			execution: {
				kind: 'static-catalog',
				artifact: { kind: 'built-module' },
				update: { kind: 'catalog-hmr' },
			},
			badge: '目录 HMR',
		},
		{
			execution: {
				kind: 'static-catalog',
				artifact: { kind: 'source-module' },
				update: { kind: 'manual' },
			},
			badge: '手动重载',
		},
		{
			execution: {
				kind: 'dynamic-fixed',
				artifact: { kind: 'built-module' },
				update: { kind: 'host-reload' },
			},
			badge: '宿主重载',
		},
		{
			execution: {
				kind: 'dynamic-entry',
				artifact: { kind: 'source-module' },
				update: { kind: 'definition-hmr', scope: 'source-graph' },
			},
			badge: '源码 HMR',
		},
		{
			execution: {
				kind: 'dynamic-entry',
				artifact: { kind: 'built-module' },
				update: { kind: 'definition-hmr', scope: 'entry-only' },
			},
			badge: '入口 HMR',
		},
		{
			execution: {
				kind: 'dynamic-entry',
				artifact: { kind: 'unreported' },
				update: { kind: 'definition-hmr', scope: 'entry-only' },
			},
			badge: '入口 HMR',
		},
		{
			execution: {
				kind: 'unreported',
				artifact: { kind: 'unreported' },
				update: { kind: 'unreported' },
			},
			badge: '更新未报告',
		},
	])('maps $execution.kind to the compact $badge badge', ({ execution, badge }) => {
		expect(describePluginExecution(execution).badgeLabel).toBe(badge)
	})

	it('describes static Vite catalog HMR without hiding its application rebuild boundary', () => {
		expect(
			describePluginExecution({
				kind: 'static-catalog',
				artifact: { kind: 'unreported' },
				update: { kind: 'catalog-hmr' },
			}),
		).toMatchObject({
			badgeLabel: '目录 HMR',
			badgeTone: 'blue',
			artifactLabel: '制品未报告',
			updateLabel: '应用模块图变化时热替换插件目录；entry/应用配置边界变化时重建应用',
			searchTerms: expect.arrayContaining(['hmr', 'catalog-hmr', '目录 HMR', '重建应用']),
		})
	})

	it('derives package and source identity only from the definition address', () => {
		expect(
			describePluginDefinition({ entry: packageEntry, exportName: 'ToolsPlugin' }),
		).toMatchObject({
			kindLabel: '包',
			compactLabel: '@fixture/tools',
			detailLabel: '@fixture/tools · ToolsPlugin',
			packageName: '@fixture/tools',
			exportName: 'ToolsPlugin',
		})
		expect(
			describePluginDefinition({ entry: sourceEntry, exportName: 'ToolsPlugin' }),
		).toMatchObject({
			kindLabel: '源码',
			compactLabel: 'workspace:plugins/tools.ts',
			sourceSpace: 'workspace',
			path: 'plugins/tools.ts',
			exportName: 'ToolsPlugin',
		})
	})

	it('derives the detail copy value from the canonical address instead of trusting display text', () => {
		const address: PluginNodeAddress = {
			definition: { entry: packageEntry, exportName: 'ToolsPlugin' },
			variant: 'default',
		}
		const runtime = describePluginRuntime({
			address,
			reference: 'forged display reference',
			execution: {
				kind: 'static-bundle',
				artifact: { kind: 'application-bundle' },
				update: { kind: 'deployment' },
			},
			recentUpdate: null,
		})

		expect(runtime.canonicalReference).toBe('package:@fixture/tools::ToolsPlugin')
		expect(runtime.definition.packageName).toBe('@fixture/tools')
	})

	it('does not conflate retained, restored, and committed-with-issues outcomes', () => {
		expect(
			describePluginRecentUpdate({
				batch: {
					scope: 'definitions',
					outcome: 'retained-previous',
					phase: 'evaluate',
					sequence: 7,
					durationMs: 12,
				},
				lifecycle: null,
			}),
		).toMatchObject({
			label: '更新失败 · 已保留上一版本',
			tone: 'yellow',
			meta: '#7 · 12 ms · 模块求值阶段',
		})
		expect(
			describePluginRecentUpdate({
				batch: {
					scope: 'definitions',
					outcome: 'applied-with-issues',
					phase: 'lifecycle',
					sequence: 8,
					durationMs: 2.5,
				},
				lifecycle: null,
			}),
		).toMatchObject({
			label: '定义已更新 · 生命周期未报告',
			tone: 'gray',
			warning: false,
			meta: '#8 · 2.5 ms · 生命周期阶段',
		})
		expect(
			describePluginRecentUpdate({
				batch: {
					scope: 'definitions',
					outcome: 'applied-with-issues',
					phase: 'commit',
					sequence: 9,
					durationMs: 3,
				},
				lifecycle: null,
			}),
		).toMatchObject({
			label: '本批更新已提交 · 提交后异常',
			tone: 'red',
			meta: '#9 · 3 ms · 提交阶段',
		})
		expect(
			describePluginRecentUpdate({
				batch: {
					scope: 'application',
					outcome: 'restored-previous',
					phase: 'application-reload',
					sequence: 10,
					durationMs: 125,
				},
				lifecycle: null,
			}),
		).toMatchObject({
			label: '应用重载失败 · 已用上一应用定义恢复',
			tone: 'yellow',
			meta: '#10 · 125 ms · 已启动全新补偿宿主，未复活旧运行代',
		})
		expect(describePluginRecentUpdate(null).label).toBe('本进程暂无更新记录')
	})
	it('does not turn a healthy node red because its application update contains another failure', () => {
		const result = describePluginRecentUpdate({
			batch: {
				scope: 'application',
				outcome: 'applied-with-issues',
				phase: 'lifecycle',
				sequence: 1,
				durationMs: 5,
			},
			lifecycle: { issues: [] },
		})
		expect(result).toMatchObject({ warning: false, tone: 'teal', label: '本插件更新完成' })
		expect(result.batchLabel).toContain('部分生命周期异常')
	})
})
