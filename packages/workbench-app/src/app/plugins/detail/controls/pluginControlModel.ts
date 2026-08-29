import type { PluginStatusEntry } from '../../pluginOverview'
import type { PluginLifecycleCommand } from '../../pluginStatusActions'

export type PluginControlPending = 'auto-start' | PluginLifecycleCommand | null

export type PluginStatusTone = 'green' | 'yellow' | 'gray' | 'red' | 'blue'

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
	const statusLabel = !available
		? '不可用'
		: running
			? '运行中'
			: wantsRunning
				? '等待启动'
				: '已停止'
	const statusTone: PluginStatusTone = !available
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
		statusDescription: !available
			? wantsRunning
				? '当前 Plugin node 不可用，无法启动；仍可停止以清除本次会话运行意图'
				: '当前 Plugin node 不可用，无法启动或重启'
			: running
				? `由${status.activationReason ? ACTIVATION_REASON_LABEL[status.activationReason] : '运行时协调'}激活`
				: wantsRunning
					? '运行时仍期望该 Plugin 运行，可重试启动或停止本次会话意图'
					: '当前会话不要求该 Plugin 运行',
		primaryCommand,
		primaryLabel,
		primaryTone,
		showStop: running || wantsRunning,
		canStartOrRestart: available && pending === null,
		canStop: pending === null && (running || wantsRunning),
		canChangeAutoStart: available || status.autoStart,
		autoStartActionLabel: status.autoStart ? '关闭自动启动' : '开启自动启动',
		autoStartDescription: status.autoStart
			? '宿主启动时自动请求运行；关闭不会停止当前会话'
			: '宿主启动时不自动运行；仍可单独启动当前会话',
		sessionIntentLabel: SESSION_INTENT_LABEL[status.sessionIntent],
		desiredStateLabel: wantsRunning ? '期望运行' : '期望停止',
		activationReasonLabel: status.activationReason
			? ACTIVATION_REASON_LABEL[status.activationReason]
			: '无',
	})
}
