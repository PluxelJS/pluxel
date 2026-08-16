// ActionBar.tsx

import { ActionIcon, Button, Group, Switch, Text, Tooltip } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { openConfirmModal } from '@mantine/modals'
import { IconPlayerPlay, IconRotateClockwise, IconSquareX } from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'
import { PluginStatusEntryLifecycleStage } from '../../../gqlens'
import { useNotify } from '../../../hooks/useNotify'
import {
	runPluginStatusAction,
	useRuntimeTransportClient,
	type PluginStatusAction,
} from '../../../../runtime'
import { usePluginScope } from '../context'
import { PLUGIN_DETAIL_HOTKEYS, PLUGIN_DETAIL_HOTKEY_LABELS } from '../../../workbench/shortcuts'

export interface ActionBarProps {
	compact?: boolean
	prominent?: boolean
}

const ACTION_LABEL: Record<PluginStatusAction, string> = {
	start: '启动',
	stop: '终止',
	restart: '重启',
	enable: '启用',
	'enable-persisted': '持久启用',
	disable: '禁用',
}

type ActionBarButtonProps = {
	action: 'restart' | 'start' | 'stop'
	busy: boolean
	canToggle: boolean
	compact: boolean
	isRunning: boolean
	onAction: (action: PluginStatusAction) => void
	prominent: boolean
}

function ActionBarButton({
	action,
	busy,
	canToggle,
	compact,
	isRunning,
	onAction,
	prominent,
}: ActionBarButtonProps) {
	const isRestart = action === 'restart'
	const isStart = action === 'start'
	const disabled = !canToggle || (isStart ? isRunning : !isRunning)
	const label = busy
		? '同步中…'
		: isRestart
			? `重启 (${PLUGIN_DETAIL_HOTKEY_LABELS.restartPlugin})`
			: ACTION_LABEL[action]
	const iconSize = prominent ? 16 : compact ? 16 : 18
	const buttonSize = compact ? 'md' : 'lg'
	const icon =
		action === 'start' ? (
			<IconPlayerPlay size={iconSize} />
		) : action === 'stop' ? (
			<IconSquareX size={iconSize} />
		) : (
			<IconRotateClockwise size={iconSize} />
		)

	if (prominent) {
		return (
			<Tooltip label={label}>
				<Button
					className={
						isStart
							? 'plx-pluginWorkbench__actionButton plx-pluginWorkbench__actionButton--primary'
							: 'plx-pluginWorkbench__actionButton'
					}
					variant={isStart ? 'filled' : isRestart ? 'default' : 'light'}
					color={action === 'stop' ? 'red' : undefined}
					size="compact-sm"
					leftSection={icon}
					onClick={() => onAction(action)}
					disabled={disabled}
				>
					{ACTION_LABEL[action]}
					{isRestart ? (
						<span className="plx-pluginWorkbench__actionKeyHint">
							{PLUGIN_DETAIL_HOTKEY_LABELS.restartPlugin}
						</span>
					) : null}
				</Button>
			</Tooltip>
		)
	}

	return (
		<Tooltip label={label}>
			<ActionIcon
				variant="light"
				size={buttonSize}
				color={action === 'stop' ? 'red' : isRestart ? 'green' : undefined}
				onClick={() => onAction(action)}
				disabled={disabled}
			>
				{icon}
			</ActionIcon>
		</Tooltip>
	)
}

export function ActionBar({ compact = false, prominent = false }: ActionBarProps) {
	const transport = useRuntimeTransportClient()
	const {
		owner,
		pluginName,
		dependencies,
		isRunning,
		isEnabled,
		lifecycleStage,
		isSyncing,
		refetch,
		setStatusOverride,
	} = usePluginScope()

	// 乱序防护：只接受最后一次操作的结果
	const seqRef = useRef(0)
	const [isLoading, setIsLoading] = useState(false)

	const notify = useNotify()

	const applyOptimistic = useCallback(
		(action: PluginStatusAction) => {
			if (!pluginName) return
			if (!setStatusOverride) return
			const currentEnabled = Boolean(isEnabled)
			const currentRunning = Boolean(isRunning)
			let nextRunning = currentRunning
			let nextEnabled = currentEnabled
			let nextStage = lifecycleStage
			switch (action) {
				case 'start':
				case 'restart':
					nextRunning = true
					nextEnabled = true
					nextStage = PluginStatusEntryLifecycleStage.running
					break
				case 'stop':
					nextRunning = false
					nextStage = currentEnabled
						? PluginStatusEntryLifecycleStage.stopped
						: PluginStatusEntryLifecycleStage.disabled
					break
				case 'disable':
					nextRunning = false
					nextEnabled = false
					nextStage = PluginStatusEntryLifecycleStage.disabled
					break
				case 'enable':
					nextEnabled = true
					nextRunning = true
					nextStage = PluginStatusEntryLifecycleStage.running
					break
				case 'enable-persisted':
					nextEnabled = true
					nextStage = currentRunning
						? PluginStatusEntryLifecycleStage.running
						: PluginStatusEntryLifecycleStage.stopped
					break
				default:
					break
			}
			setStatusOverride({
				isRunning: nextRunning,
				isEnabled: nextEnabled,
				lifecycleStage: nextStage,
			})
		},
		[pluginName, setStatusOverride, isEnabled, isRunning, lifecycleStage],
	)

	const syncAfterSuccess = useCallback(async () => {
		await refetch()
	}, [refetch])

	const performAction = async (action: PluginStatusAction) => {
		if (!pluginName) return
		const mySeq = ++seqRef.current

		// ① 全局乐观：立即写入运行/同步态
		applyOptimistic(action)
		setIsLoading(true)

		try {
			const res = await transport.withRpc((rpc) => runPluginStatusAction(rpc, owner, action))
			if (mySeq !== seqRef.current) return

			if (res.ok === false) {
				notify({
					title: '插件状态更新失败',
					message: res.error || res.commitError || '操作失败，请稍后重试',
					color: 'red',
				})
				// 失败直接以真实数据为准（无需手写回滚）：拉齐一次
				await refetch()
				return
			}

			// ② 成功：让返回覆盖乐观态，再进行一次精准对齐
			await syncAfterSuccess()

			notify({
				title: '插件状态已更新',
				message: `${pluginName} ${ACTION_LABEL[action]}成功`,
				color: 'green',
			})
		} catch (e: any) {
			if (mySeq !== seqRef.current) return
			notify({
				title: '插件状态更新失败',
				message: e?.message ?? '操作失败，请稍后重试',
				color: 'red',
			})
			await refetch()
		} finally {
			setIsLoading(false)
		}
	}

	const handleAction = (action: PluginStatusAction) => {
		const needsDependencyCheck = action === 'start' || action === 'restart'
		const missing = needsDependencyCheck
			? dependencies.filter((dependency) => !dependency.isRunning)
			: []

		const proceed = (): void => {
			void performAction(action)
		}

		if (missing.length > 0) {
			openConfirmModal({
				title: '前置依赖未启动',
				children: (
					<div>
						<div>启动当前插件时，运行时会按结构化依赖图启动所需节点。</div>
						<div style={{ marginTop: 10 }}>
							以下依赖尚未运行：{missing.map((item) => item.name).join('，')}
						</div>
					</div>
				),
				labels: { confirm: '继续启动', cancel: '取消' },
				onConfirm: proceed,
				closeOnConfirm: true,
			})
		} else {
			proceed()
		}
	}

	const busy = isLoading || isSyncing
	const canToggle = !busy
	const persistDisabled = busy
	const switchSize = compact ? 'sm' : 'md'

	useHotkeys(
		prominent
			? [
					[
						PLUGIN_DETAIL_HOTKEYS.restartPlugin,
						(event: KeyboardEvent) => {
							event.preventDefault()
							if (!canToggle || !isRunning) return
							handleAction('restart')
						},
					],
				]
			: [],
	)

	if (prominent) {
		return (
			<Group
				gap={8}
				justify="flex-end"
				wrap="nowrap"
				className="plx-pluginWorkbench__actionBar"
				data-prominent="true"
			>
				<div className="plx-pluginWorkbench__actionPersist">
					<div className="plx-pluginWorkbench__actionPersistText">
						<Text size="xs" fw={600}>
							持久启用
						</Text>
						<Text size="xs" c="dimmed">
							{busy ? '状态同步中…' : isEnabled ? '重启后继续保持启用' : '仅本次运行生效'}
						</Text>
					</div>
					<Tooltip
						label={
							busy
								? '同步中…'
								: isEnabled
									? '禁用后将停止运行并移除持久启用'
									: '启用后可持久保留该插件'
						}
					>
						<Switch
							size="sm"
							checked={isEnabled}
							disabled={persistDisabled}
							onChange={(event) =>
								void performAction(event.currentTarget.checked ? 'enable' : 'disable')
							}
						/>
					</Tooltip>
				</div>

				<ActionBarButton
					action="start"
					busy={busy}
					canToggle={canToggle}
					compact={compact}
					isRunning={isRunning}
					onAction={handleAction}
					prominent
				/>
				<ActionBarButton
					action="stop"
					busy={busy}
					canToggle={canToggle}
					compact={compact}
					isRunning={isRunning}
					onAction={handleAction}
					prominent
				/>
				<ActionBarButton
					action="restart"
					busy={busy}
					canToggle={canToggle}
					compact={compact}
					isRunning={isRunning}
					onAction={handleAction}
					prominent
				/>
			</Group>
		)
	}

	return (
		<Group
			gap={compact ? 6 : 'xs'}
			justify="flex-end"
			wrap="nowrap"
			className="plx-pluginWorkbench__actionBar"
		>
			<Tooltip
				label={
					busy ? '同步中…' : isEnabled ? '禁用后将停止运行并移除持久启用' : '启用后可持久保留该插件'
				}
			>
				<Switch
					size={switchSize}
					checked={isEnabled}
					onLabel={compact ? '' : '启用'}
					offLabel={compact ? '' : '禁用'}
					disabled={persistDisabled}
					onChange={(event) =>
						void performAction(event.currentTarget.checked ? 'enable' : 'disable')
					}
				/>
			</Tooltip>

			<ActionBarButton
				action="start"
				busy={busy}
				canToggle={canToggle}
				compact={compact}
				isRunning={isRunning}
				onAction={handleAction}
				prominent={false}
			/>
			<ActionBarButton
				action="stop"
				busy={busy}
				canToggle={canToggle}
				compact={compact}
				isRunning={isRunning}
				onAction={handleAction}
				prominent={false}
			/>
			<ActionBarButton
				action="restart"
				busy={busy}
				canToggle={canToggle}
				compact={compact}
				isRunning={isRunning}
				onAction={handleAction}
				prominent={false}
			/>
		</Group>
	)
}
