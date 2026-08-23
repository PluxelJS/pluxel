// ActionBar.tsx

import { ActionIcon, Button, Group, Switch, Text, Tooltip } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { openConfirmModal } from '@mantine/modals'
import { IconRotateClockwise } from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'
import { PluginStatusEntryLifecycleStage } from '../../pluginOverview'
import { useNotify } from '../../../hooks/useNotify'
import {
	runtimeErrorMessage,
	type PluginStatusAction,
	useRuntimeManagementClient,
} from '../../../../runtime'
import { updatePluginStatus } from '../../pluginStatusActions'
import { usePluginScope } from '../context'
import { PLUGIN_DETAIL_HOTKEYS, PLUGIN_DETAIL_HOTKEY_LABELS } from '../../../workbench/shortcuts'

export interface ActionBarProps {
	compact?: boolean
	prominent?: boolean
}

const ACTION_LABEL: Record<PluginStatusAction, string> = {
	restart: '重启',
	enable: '启用',
	disable: '禁用',
}

type ActionBarButtonProps = {
	busy: boolean
	canRestart: boolean
	compact: boolean
	onAction: (action: PluginStatusAction) => void
	prominent: boolean
}

function ActionBarButton({ busy, canRestart, compact, onAction, prominent }: ActionBarButtonProps) {
	const action = 'restart' as const
	const disabled = !canRestart
	const label = busy ? '同步中…' : `重启 (${PLUGIN_DETAIL_HOTKEY_LABELS.restartPlugin})`
	const iconSize = prominent ? 16 : compact ? 16 : 18
	const buttonSize = compact ? 'md' : 'lg'
	const icon = <IconRotateClockwise size={iconSize} />

	if (prominent) {
		return (
			<Tooltip label={label}>
				<Button
					className="plx-pluginWorkbench__actionButton"
					variant="default"
					size="compact-sm"
					leftSection={icon}
					onClick={() => onAction(action)}
					disabled={disabled}
				>
					{ACTION_LABEL[action]}
					<span className="plx-pluginWorkbench__actionKeyHint">
						{PLUGIN_DETAIL_HOTKEY_LABELS.restartPlugin}
					</span>
				</Button>
			</Tooltip>
		)
	}

	return (
		<Tooltip label={label}>
			<ActionIcon
				variant="light"
				size={buttonSize}
				color="green"
				onClick={() => onAction(action)}
				disabled={disabled}
			>
				{icon}
			</ActionIcon>
		</Tooltip>
	)
}

export function ActionBar({ compact = false, prominent = false }: ActionBarProps) {
	const management = useRuntimeManagementClient()
	const {
		owner,
		pluginLabel,
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
			if (!pluginLabel) return
			if (!setStatusOverride) return
			const currentEnabled = Boolean(isEnabled)
			const currentRunning = Boolean(isRunning)
			let nextRunning = currentRunning
			let nextEnabled = currentEnabled
			let nextStage = lifecycleStage
			switch (action) {
				case 'restart':
					nextRunning = true
					nextStage = PluginStatusEntryLifecycleStage.running
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
			}
			setStatusOverride({
				isRunning: nextRunning,
				isEnabled: nextEnabled,
				lifecycleStage: nextStage,
			})
		},
		[pluginLabel, setStatusOverride, isEnabled, isRunning, lifecycleStage],
	)

	const syncAfterSuccess = useCallback(async () => {
		await refetch()
	}, [refetch])

	const performAction = async (action: PluginStatusAction) => {
		if (!pluginLabel) return
		const mySeq = ++seqRef.current

		// ① 全局乐观：立即写入运行/同步态
		applyOptimistic(action)
		setIsLoading(true)

		try {
			const res = await updatePluginStatus(management, owner, action)
			if (mySeq !== seqRef.current) return

			if (res.ok === false) {
				notify({
					title: '插件状态更新失败',
					message: res.error || '操作失败，请稍后重试',
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
				message: `${pluginLabel} ${ACTION_LABEL[action]}成功`,
				color: 'green',
			})
		} catch (error: unknown) {
			if (mySeq !== seqRef.current) return
			notify({
				title: '插件状态更新失败',
				message: runtimeErrorMessage(error, '操作失败，请稍后重试'),
				color: 'red',
			})
			await refetch()
		} finally {
			setIsLoading(false)
		}
	}

	const handleAction = (action: PluginStatusAction) => {
		const needsDependencyCheck = action === 'enable' || action === 'restart'
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
							以下依赖尚未运行：{missing.map((item) => item.label).join('，')}
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
	const canRestart = !busy && Boolean(isEnabled)
	const persistDisabled = busy
	const switchSize = compact ? 'sm' : 'md'

	useHotkeys(
		prominent
			? [
					[
						PLUGIN_DETAIL_HOTKEYS.restartPlugin,
						(event: KeyboardEvent) => {
							event.preventDefault()
							if (!canRestart) return
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
							{busy ? '状态同步中…' : isEnabled ? '重启后继续保持启用' : '当前已禁用'}
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
							onChange={(event) => handleAction(event.currentTarget.checked ? 'enable' : 'disable')}
						/>
					</Tooltip>
				</div>

				<ActionBarButton
					busy={busy}
					canRestart={canRestart}
					compact={compact}
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
					onChange={(event) => handleAction(event.currentTarget.checked ? 'enable' : 'disable')}
				/>
			</Tooltip>

			<ActionBarButton
				busy={busy}
				canRestart={canRestart}
				compact={compact}
				onAction={handleAction}
				prominent={false}
			/>
		</Group>
	)
}
