import {
	formatPluginNodeReference,
	type PluginDefinitionAddress,
	type PluginEntryAddress,
} from '@pluxel/core'
import type {
	PluginExecutionSnapshot,
	PluginRecentUpdateSnapshot,
	PluginStatusSnapshot,
} from '@pluxel/runtime/web'

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
	if (entry.kind === 'package-root') {
		return {
			entryKind: entry.kind,
			kindLabel: '包',
			compactLabel: entry.packageName,
			detailLabel: `${entry.packageName} · ${exportName}`,
			packageName: entry.packageName,
			sourceSpace: null,
			path: null,
			exportName,
			searchTerms: ['package', 'package-root', '包', entry.packageName, exportName],
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
		case 'static-bundle':
			return {
				badgeLabel: '部署更新',
				badgeTone: 'gray',
				currentLabel: '应用静态构建',
				artifactLabel: '应用 Bundle',
				updateLabel: '部署新版本',
				searchTerms: [
					'static',
					'bundle',
					'static-bundle',
					'application-bundle',
					'deployment',
					'静态构建',
					'应用 Bundle',
					'部署',
				],
			}
		case 'static-catalog': {
			const manual = execution.update.kind === 'manual'
			return {
				badgeLabel: manual ? '手动重载' : '目录 HMR',
				badgeTone: manual ? 'orange' : 'blue',
				currentLabel: '静态插件目录',
				artifactLabel: artifactLabel(execution.artifact.kind),
				updateLabel: manual
					? '手动重载插件目录'
					: '应用模块图变化时热替换插件目录；entry/应用配置边界变化时重建应用',
				searchTerms: [
					'static',
					'catalog',
					'static-catalog',
					execution.artifact.kind,
					execution.update.kind,
					artifactLabel(execution.artifact.kind),
					'静态目录',
					...(manual
						? ['手动重载']
						: ['hmr', 'catalog-hmr', '目录 HMR', '应用模块图', '热替换插件目录', '重建应用']),
				],
			}
		}
		case 'dynamic-fixed':
			return {
				badgeLabel: '宿主重载',
				badgeTone: 'orange',
				currentLabel: '动态固定集合',
				artifactLabel: artifactLabel(execution.artifact.kind),
				updateLabel: '重载宿主后生效',
				searchTerms: [
					'dynamic',
					'fixed',
					'dynamic-fixed',
					'host-reload',
					execution.artifact.kind,
					artifactLabel(execution.artifact.kind),
					'动态固定',
					'宿主重载',
				],
			}
		case 'dynamic-entry': {
			const sourceGraph = execution.update.scope === 'source-graph'
			return {
				badgeLabel: sourceGraph ? '源码 HMR' : '入口 HMR',
				badgeTone: sourceGraph ? 'blue' : 'cyan',
				currentLabel: '动态插件入口',
				artifactLabel: artifactLabel(execution.artifact.kind),
				updateLabel: sourceGraph ? '源码依赖图 HMR' : '仅监听插件入口',
				searchTerms: [
					'dynamic',
					'entry',
					'dynamic-entry',
					'definition-hmr',
					execution.update.scope,
					execution.artifact.kind,
					artifactLabel(execution.artifact.kind),
					'hmr',
					'动态入口',
					sourceGraph ? '源码 HMR' : '入口 HMR',
				],
			}
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
				label: lifecycleIssue ? '新版本已提交 · 生命周期异常' : '新版本已提交 · 提交后异常',
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
	phase: Extract<PluginRecentUpdateSnapshot, { outcome: 'retained-previous' }>['phase'],
): string {
	switch (phase) {
		case 'evaluate':
			return '模块求值阶段'
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
