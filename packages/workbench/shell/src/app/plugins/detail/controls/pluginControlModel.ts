import { pluginNodeAddressEqual } from '@pluxel/core'
import type { PluginControlMutationSuccess } from '@pluxel/services/management/client'
import type { PluginStatusEntry } from '../../pluginOverview'
import type { PluginLifecycleCommand } from '../../pluginStatusActions'

export type PluginControlPending = 'auto-start' | PluginLifecycleCommand | null

export type PluginStatusTone = 'green' | 'yellow' | 'gray' | 'red' | 'blue'

export type PluginLifecycleOutcomePresentation = Readonly<{
	title: string
	message: string
	color: 'green' | 'yellow' | 'red'
	diagnosticText?: string
}>

const ACTIVATION_REASON_LABEL: Record<
	Exclude<PluginStatusEntry['activationReason'], null>,
	string
> = {
	'auto-start': '自动启动',
	session: '本次会话',
	dependency: '依赖协调',
}

const SESSION_INTENT_LABEL: Record<PluginStatusEntry['sessionIntent'], string> = {
	inherit: '跟随自动启动策略',
	run: '本次会话保持运行',
	stop: '本次会话保持停止',
}

export function describePluginControl(
	status: PluginStatusEntry,
	pending: PluginControlPending = null,
) {
	const available = status.availability === 'available'
	const running = status.lifecycleState === 'running'
	const wantsRunning = status.desiredState === 'running'
	const failure = status.issues.find((issue) =>
		[
			'resolve-failed',
			'config-failed',
			'start-failed',
			'dependency-blocked',
			'drain-failed',
		].includes(issue.code),
	)
	const statusLabel = failure
		? failure.code === 'dependency-blocked'
			? '依赖阻塞'
			: failure.code === 'drain-failed'
				? '停止异常'
				: '启动失败'
		: !available
			? '不可用'
			: running
				? '运行中'
				: wantsRunning
					? '等待启动'
					: '已停止'
	const statusTone: PluginStatusTone = failure
		? 'red'
		: !available
			? 'red'
			: running
				? 'green'
				: wantsRunning
					? 'yellow'
					: 'gray'
	const primaryCommand: PluginLifecycleCommand = running ? 'restart' : 'start'
	const primaryLabel = running ? '重启' : wantsRunning ? '重试启动' : '启动'
	const primaryTone = running ? 'blue' : wantsRunning ? 'orange' : 'green'

	return Object.freeze({
		available,
		running,
		wantsRunning,
		statusLabel,
		statusTone,
		statusDescription: failure
			? failure.message
			: !available
				? wantsRunning
					? '插件不可用；可停止以清除运行意图'
					: '插件不可用'
				: running
					? `由${status.activationReason ? ACTIVATION_REASON_LABEL[status.activationReason] : '运行时协调'}激活`
					: wantsRunning
						? '期望运行但未运行'
						: '未要求运行',
		primaryCommand,
		primaryLabel,
		primaryTone,
		showStop: running || wantsRunning,
		canStartOrRestart: available && pending === null,
		canStop: pending === null && (running || wantsRunning),
		canChangeAutoStart: available || status.autoStart,
		autoStartActionLabel: status.autoStart ? '关闭自动启动' : '开启自动启动',
		autoStartDescription: status.autoStart ? '随宿主启动' : '不随宿主启动',
		sessionIntentLabel: SESSION_INTENT_LABEL[status.sessionIntent],
		desiredStateLabel: wantsRunning ? '期望运行' : '期望停止',
		activationReasonLabel: status.activationReason
			? ACTIVATION_REASON_LABEL[status.activationReason]
			: '无',
	})
}

export function describePluginLifecycleOutcome(
	pluginLabel: string,
	command: PluginLifecycleCommand,
	result: PluginControlMutationSuccess,
): PluginLifecycleOutcomePresentation {
	const report = result.report.core
	const issue =
		report.status === 'committed'
			? report.summary.lifecycleReport.issues.find((candidate) =>
					pluginNodeAddressEqual(candidate.plugin, result.address),
				)
			: undefined
	if (issue) {
		const detail = issue.error?.message || issue.message
		const partPath = issue.error?.partPath
		return Object.freeze({
			title:
				command === 'stop'
					? 'Plugin 停止异常'
					: command === 'restart'
						? 'Plugin 重启失败'
						: 'Plugin 启动失败',
			message: `${pluginLabel}：${detail}${partPath?.length ? `（PluginPart：${partPath.join(' / ')}）` : ''}`,
			color: 'red',
			diagnosticText: JSON.stringify(
				{
					command,
					address: result.address,
					lifecycleReport: report.status === 'committed' ? report.summary.lifecycleReport : null,
				},
				null,
				2,
			),
		})
	}

	const expectedRunning = command !== 'stop'
	const running = result.control.lifecycleState === 'running'
	if (running !== expectedRunning) {
		return Object.freeze({
			title: '命令已提交，状态未收敛',
			message: `${pluginLabel} 仍${running ? '在运行' : '未运行'}`,
			color: 'yellow',
		})
	}

	return Object.freeze({
		title:
			command === 'stop'
				? 'Plugin 已停止'
				: command === 'restart'
					? 'Plugin 已重启'
					: 'Plugin 已启动',
		message: pluginLabel,
		color: 'green',
	})
}
