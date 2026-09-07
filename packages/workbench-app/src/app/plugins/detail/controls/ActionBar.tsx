import { Badge, Button, Group, Switch, Text, Tooltip } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { openConfirmModal } from '@mantine/modals'
import { IconPlayerPlay, IconPlayerStop, IconRotateClockwise } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { formatPluginDefinitionReference, formatPluginNodeReference } from '@pluxel/core'
import { useNotify } from '../../../hooks/useNotify'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../../../runtime'
import {
	applyPluginLifecycleCommand,
	setPluginAutoStart,
	type PluginLifecycleCommand,
} from '../../pluginStatusActions'
import { usePluginScope } from '../context'
import { PLUGIN_DETAIL_HOTKEYS, PLUGIN_DETAIL_HOTKEY_LABELS } from '../../../workbench/shortcuts'
import { describePluginControl, describePluginLifecycleOutcome } from './pluginControlModel'

export function ActionBar() {
	const management = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const { owner, pluginLabel, dependencyGraph, status, refetch } = usePluginScope()
	const notify = useNotify()
	const autoStartPendingRef = useRef(false)
	const lifecyclePendingRef = useRef(false)
	const [autoStartPending, setAutoStartPending] = useState(false)
	const [lifecyclePending, setLifecyclePending] = useState<PluginLifecycleCommand | null>(null)
	const presentation = describePluginControl(status, lifecyclePending)

	const performAutoStart = async (autoStart: boolean) => {
		if (autoStartPendingRef.current) return
		autoStartPendingRef.current = true
		setAutoStartPending(true)
		try {
			const result = await setPluginAutoStart(management, queryClient, owner, autoStart)
			if (result.ok === false) {
				notify({
					title: '自动启动策略更新失败',
					message: result.error || '操作失败，请稍后重试',
					color: 'red',
				})
				return
			}
			notify({
				title: autoStart ? '已开启自动启动' : '已关闭自动启动',
				message: autoStart
					? `${pluginLabel} 将在宿主启动时自动请求运行；当前会话状态不变。`
					: `${pluginLabel} 当前会话状态不变。`,
				color: 'green',
			})
		} catch (error: unknown) {
			notify({
				title: '自动启动策略更新失败',
				message: runtimeErrorMessage(error, '操作失败，请稍后重试'),
				color: 'red',
			})
			await refetch()
		} finally {
			autoStartPendingRef.current = false
			setAutoStartPending(false)
		}
	}

	const performLifecycleCommand = async (command: PluginLifecycleCommand) => {
		if (lifecyclePendingRef.current) return
		lifecyclePendingRef.current = true
		setLifecyclePending(command)
		try {
			const result = await applyPluginLifecycleCommand(management, queryClient, owner, command)
			if (result.ok === false) {
				notify({
					title: '生命周期命令执行失败',
					message: result.error || '操作失败，请稍后重试',
					color: 'red',
				})
				return
			}
			notify(describePluginLifecycleOutcome(pluginLabel, command, result))
		} catch (error: unknown) {
			notify({
				title: '生命周期命令执行失败',
				message: runtimeErrorMessage(error, '操作失败，请稍后重试'),
				color: 'red',
			})
			await refetch()
		} finally {
			lifecyclePendingRef.current = false
			setLifecyclePending(null)
		}
	}

	const handleLifecycleCommand = (command: PluginLifecycleCommand) => {
		if (command === 'stop') {
			const effectiveDependents = [...(dependencyGraph.detail?.dependents.effective ?? [])].filter(
				(dependent) => dependent.edge.mode === 'required',
			)
			if (effectiveDependents.length > 0) {
				openConfirmModal({
					title: '停止 Plugin？',
					children: (
						<Text size="sm">
							停止本次会话会影响 {effectiveDependents.length} 个当前生效的必须依赖方；
							自动启动策略不会改变。
						</Text>
					),
					labels: { confirm: '停止', cancel: '取消' },
					confirmProps: { color: 'red' },
					onConfirm: () => void performLifecycleCommand(command),
				})
				return
			}
			void performLifecycleCommand(command)
			return
		}

		const unavailable = (dependencyGraph.detail?.required ?? []).filter((dependency) => {
			if (!dependency.provider || dependency.provider.state === 'absent') return true
			return dependency.provider.node.status.availability !== 'available'
		})
		if (unavailable.length === 0) {
			void performLifecycleCommand(command)
			return
		}
		openConfirmModal({
			title: '前置依赖不可用',
			children: (
				<div>
					<div>运行时会协调启动可用但尚未运行的依赖；以下依赖当前无法启动：</div>
					<div style={{ marginTop: 10 }}>
						{unavailable
							.map((item) => {
								if (!item.provider) return formatPluginDefinitionReference(item.edge.requirement)
								return item.provider.state === 'status'
									? item.provider.node.status.label.text
									: formatPluginNodeReference(item.provider.address)
							})
							.join('，')}
					</div>
				</div>
			),
			labels: { confirm: command === 'restart' ? '继续重启' : '继续启动', cancel: '取消' },
			onConfirm: () => void performLifecycleCommand(command),
		})
	}

	useHotkeys([
		[
			PLUGIN_DETAIL_HOTKEYS.restartPlugin,
			(event: KeyboardEvent) => {
				event.preventDefault()
				if (!presentation.canStartOrRestart || status.lifecycleState !== 'running') return
				handleLifecycleCommand('restart')
			},
		],
	])

	const primaryIcon =
		presentation.primaryCommand === 'restart' ? (
			<IconRotateClockwise size={15} />
		) : (
			<IconPlayerPlay size={15} />
		)

	return (
		<Group gap={6} justify="flex-end" wrap="nowrap" className="plx-pluginWorkbench__actionBar">
			<Tooltip label={presentation.statusDescription}>
				<Badge variant="light" color={presentation.statusTone} radius="sm" size="sm">
					{presentation.statusLabel}
				</Badge>
			</Tooltip>
			<Tooltip
				label={autoStartPending ? '正在保存自动启动策略…' : presentation.autoStartDescription}
			>
				<Switch
					className="plx-pluginWorkbench__actionPolicy"
					size="sm"
					color="green"
					label="自动启动"
					labelPosition="left"
					checked={status.autoStart}
					disabled={autoStartPending || !presentation.canChangeAutoStart}
					aria-label={presentation.autoStartActionLabel}
					aria-busy={autoStartPending}
					onChange={(event) => void performAutoStart(event.currentTarget.checked)}
				/>
			</Tooltip>

			<Button.Group
				className="plx-pluginWorkbench__lifecycleActions"
				aria-label="当前会话生命周期操作"
			>
				{presentation.showStop ? (
					<Button
						className="plx-pluginWorkbench__actionButton"
						variant="light"
						color="red"
						radius="md"
						size="compact-sm"
						leftSection={<IconPlayerStop size={15} />}
						disabled={!presentation.canStop}
						onClick={() => handleLifecycleCommand('stop')}
					>
						{lifecyclePending === 'stop' ? '停止中…' : '停止'}
					</Button>
				) : null}

				<Tooltip
					label={
						presentation.primaryCommand === 'restart'
							? `${presentation.primaryLabel} (${PLUGIN_DETAIL_HOTKEY_LABELS.restartPlugin})`
							: presentation.primaryLabel
					}
				>
					<Button
						className="plx-pluginWorkbench__actionButton"
						variant={presentation.running ? 'light' : 'filled'}
						color={presentation.primaryTone}
						radius="md"
						size="compact-sm"
						leftSection={primaryIcon}
						disabled={!presentation.canStartOrRestart}
						onClick={() => handleLifecycleCommand(presentation.primaryCommand)}
					>
						{lifecyclePending === presentation.primaryCommand
							? '执行中…'
							: presentation.primaryLabel}
					</Button>
				</Tooltip>
			</Button.Group>
		</Group>
	)
}
