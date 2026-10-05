import {
	formatPluginNodeReference,
	type PluginDefinitionAddress,
	type PluginEntryAddress,
} from '@pluxel/core'
import type {
	PluginExecutionSnapshot,
	PluginRecentUpdateSnapshot,
	PluginStatusSnapshot,
} from '@pluxel/services/management/client'

export type PluginPresentationTone = 'blue' | 'cyan' | 'gray' | 'orange' | 'red' | 'teal' | 'yellow'

export type PluginDefinitionPresentation = Readonly<{
	entryKind: PluginEntryAddress['kind']
	kindLabel: '包' | '源码'
	compactLabel: string
	detailLabel: string
	packageName: string | null
	sourceSpace: string | null
	path: string | null
	exportName: string
	searchTerms: readonly string[]
}>

export type PluginExecutionPresentation = Readonly<{
	badgeLabel: string
	badgeTone: PluginPresentationTone
	currentLabel: string
	artifactLabel: string
	updateLabel: string
	searchTerms: readonly string[]
}>

export type PluginRecentUpdatePresentation = Readonly<{
	warning: boolean
	batchLabel: string | null
	details: readonly string[]
	label: string
	tone: PluginPresentationTone
	meta: string | null
	searchTerms: readonly string[]
}>

export type PluginRuntimePresentation = Readonly<{
	/** The only stable value offered for copy/share; never a loader module id or filesystem path. */
	canonicalReference: string
	definition: PluginDefinitionPresentation
	execution: PluginExecutionPresentation
	recentUpdate: PluginRecentUpdatePresentation
}>

export function describePluginRuntime(
	status: Pick<PluginStatusSnapshot, 'address' | 'reference' | 'execution' | 'recentUpdate'>,
): PluginRuntimePresentation {
	return {
		canonicalReference: formatPluginNodeReference(status.address),
		definition: describePluginDefinition(status.address.definition),
		execution: describePluginExecution(status.execution),
		recentUpdate: describePluginRecentUpdate(status.recentUpdate),
	}
}

export function describePluginDefinition(
	definition: PluginDefinitionAddress,
): PluginDefinitionPresentation {
	const { entry, exportName } = definition
	if (entry.kind !== 'source-entry') {
		const specifier =
			entry.packageName + (entry.kind === 'package-subpath' ? entry.subpath.slice(1) : '')
		return {
			entryKind: entry.kind,
			kindLabel: '包',
			compactLabel: specifier,
			detailLabel: `${specifier} · ${exportName}`,
			packageName: entry.packageName,
			sourceSpace: null,
			path: null,
			exportName,
			searchTerms: ['package', entry.kind, '包', specifier, exportName],
		}
	}

	const sourceLocation = `${entry.sourceSpace}:${entry.path}`
	return {
		entryKind: entry.kind,
		kindLabel: '源码',
		compactLabel: sourceLocation,
		detailLabel: `${sourceLocation} · ${exportName}`,
		packageName: null,
		sourceSpace: entry.sourceSpace,
		path: entry.path,
		exportName,
		searchTerms: [
			'source',
			'source-entry',
			'源码',
			entry.sourceSpace,
			entry.path,
			sourceLocation,
			exportName,
		],
	}
}

export function describePluginExecution(
	execution: PluginExecutionSnapshot,
): PluginExecutionPresentation {
	switch (execution.kind) {
		case 'native':
			return {
				badgeLabel: '下次启动',
				badgeTone: 'gray',
				currentLabel: execution.origin === 'fixed' ? 'Native 固定插件' : 'Native 来源插件',
				artifactLabel: artifactLabel(execution.artifact.kind),
				updateLabel: '新进程启动时接纳发布',
				searchTerms: [
					'native',
					execution.origin,
					execution.artifact.kind,
					'next-start',
					'下次启动',
					'原生',
					artifactLabel(execution.artifact.kind),
				],
			}
		case 'vite':
			return execution.origin === 'fixed'
				? {
						badgeLabel: '宿主重载',
						badgeTone: 'orange',
						currentLabel: 'Vite 固定插件',
						artifactLabel: artifactLabel(execution.artifact.kind),
						updateLabel: '应用及固定插件变化时重建宿主',
						searchTerms: [
							'vite',
							'fixed',
							execution.artifact.kind,
							'host-reload',
							'宿主重载',
							artifactLabel(execution.artifact.kind),
						],
					}
				: {
						badgeLabel: '定义 HMR',
						badgeTone: 'blue',
						currentLabel: 'Vite 来源插件',
						artifactLabel: artifactLabel(execution.artifact.kind),
						updateLabel: 'Vite 模块依赖图更新',
						searchTerms: [
							'vite',
							'source',
							execution.artifact.kind,
							'definition-hmr',
							'hmr',
							'定义 HMR',
							artifactLabel(execution.artifact.kind),
						],
					}
		case 'unreported':
			return {
				badgeLabel: '更新未报告',
				badgeTone: 'yellow',
				currentLabel: '执行信息未报告',
				artifactLabel: '制品未报告',
				updateLabel: '更新方式未报告',
				searchTerms: [
					'unreported',
					'unknown',
					'未报告',
					'执行信息未报告',
					'制品未报告',
					'更新未报告',
				],
			}
	}
}

export function describePluginRecentUpdate(
	update: PluginRecentUpdateSnapshot | null,
): PluginRecentUpdatePresentation {
	const batch = describeUpdateBatch(update?.batch ?? null)
	if (!update) return { ...batch, warning: false, batchLabel: null, details: [] }
	const scope = update.batch.scope === 'application' ? '应用重载' : '插件批次更新'
	const batchLabel = `${scope}：${batch.label}`
	const diagnostic = update.batch.error
	const diagnosticDetails = diagnostic
		? [
				`批次错误：${diagnostic.message}`,
				...(diagnostic.file ? [`失败文件：${diagnostic.file}`] : []),
				...(diagnostic.importChain.length > 0
					? [`导入链：${diagnostic.importChain.join(' → ')}`]
					: []),
			]
		: []
	const searchTerms = [...batch.searchTerms, ...diagnosticDetails]
	const issues = update.lifecycle?.issues ?? []
	if (issues.length > 0) {
		const first = issues[0]!
		const stages = {
			resolve: '依赖解析失败',
			config: '配置校验失败',
			start: '启动失败',
			dependency: '被依赖阻塞',
			drain: '资源清理异常',
		} as const
		return {
			label: `上次更新 · ${stages[first.phase]}`,
			tone: 'red',
			warning: true,
			batchLabel,
			meta: batch.meta,
			details: [
				...diagnosticDetails,
				...issues.map(
					(issue) =>
						`${stages[issue.phase]}：${issue.message}${issue.blockedBy ? `（依赖：${issue.blockedBy}）` : ''}`,
				),
			],
			searchTerms: [
				...searchTerms,
				...issues.flatMap((issue) => [issue.kind, issue.phase, issue.message]),
			],
		}
	}
	if (
		update.batch.outcome === 'applied' ||
		(update.batch.outcome === 'applied-with-issues' && update.batch.phase === 'lifecycle')
	) {
		return {
			...batch,
			label: update.lifecycle ? '本插件更新完成' : '定义已更新 · 生命周期未报告',
			tone: update.lifecycle ? 'teal' : 'gray',
			warning: false,
			batchLabel,
			details: diagnosticDetails,
			searchTerms,
		}
	}
	return { ...batch, warning: true, batchLabel, details: diagnosticDetails, searchTerms }
}

function describeUpdateBatch(
	update: PluginRecentUpdateSnapshot['batch'] | null,
): Omit<PluginRecentUpdatePresentation, 'warning' | 'batchLabel' | 'details'> {
	if (!update) {
		return {
			label: '本进程暂无更新记录',
			tone: 'gray',
			meta: null,
			searchTerms: ['none', 'no-update', '暂无更新记录', '本进程暂无更新记录'],
		}
	}

	const attempt = `#${update.sequence} · ${formatDuration(update.durationMs)}`
	switch (update.outcome) {
		case 'applied':
			return {
				label: '更新已应用',
				tone: 'teal',
				meta: attempt,
				searchTerms: ['applied', 'success', '更新已应用'],
			}
		case 'applied-with-issues': {
			const lifecycleIssue = update.phase === 'lifecycle'
			return {
				label: lifecycleIssue ? '本批更新已提交 · 部分生命周期异常' : '本批更新已提交 · 提交后异常',
				tone: 'red',
				meta: `${attempt} · ${lifecycleIssue ? '生命周期阶段' : '提交阶段'}`,
				searchTerms: [
					'applied-with-issues',
					update.phase,
					'新版本已提交',
					lifecycleIssue ? '生命周期异常' : '提交后异常',
				],
			}
		}
		case 'failed':
			return {
				label: '应用启动失败',
				tone: 'red',
				meta: attempt,
				searchTerms: ['failed', 'application-reload', '应用启动失败'],
			}
		case 'restored-previous':
			return {
				label: '应用重载失败 · 已用上一应用定义恢复',
				tone: 'yellow',
				meta: `${attempt} · 已启动全新补偿宿主，未复活旧运行代`,
				searchTerms: [
					'restored-previous',
					'application-reload',
					'compensation',
					'补偿',
					'更新失败',
					'上一应用定义',
					'全新补偿宿主',
				],
			}
		case 'retained-previous':
			return {
				label: '更新失败 · 已保留上一版本',
				tone: 'yellow',
				meta: `${attempt} · ${failurePhaseLabel(update.phase)}`,
				searchTerms: ['retained-previous', update.phase, '更新失败', '已保留上一版本'],
			}
	}
}

function artifactLabel(kind: PluginExecutionSnapshot['artifact']['kind']): string {
	switch (kind) {
		case 'application-bundle':
			return '应用 Bundle'
		case 'source-module':
			return '源码模块'
		case 'built-module':
			return '构建模块'
		case 'unreported':
			return '制品未报告'
	}
}

function failurePhaseLabel(
	phase: Extract<PluginRecentUpdateSnapshot['batch'], { outcome: 'retained-previous' }>['phase'],
): string {
	switch (phase) {
		case 'evaluate':
			return '模块求值阶段'
		case 'artifacts':
			return '界面产物准备阶段'
		case 'inject':
			return '注入阶段'
		case 'commit':
			return '提交阶段'
	}
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1) return `${durationMs.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} ms`
	if (durationMs < 100) return `${durationMs.toFixed(1).replace(/\.0$/, '')} ms`
	return `${Math.round(durationMs)} ms`
}
