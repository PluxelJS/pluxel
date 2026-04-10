// ActionBar.tsx

import { ActionIcon, Button, Group, Switch, Text, Tooltip } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { openConfirmModal } from '@mantine/modals'
import { IconPlayerPlay, IconRotateClockwise, IconSquareX } from '@tabler/icons-react'
import { useCallback, useRef, useState } from 'react'
import { ExtensionSlot } from '../../../../extension'
import { PluginStatusEntryLifecycleStage } from '../../../gqty'
import { useNotify } from '../../../hooks'
import {
	runPluginStatusAction,
	useRuntimeTransportClient,
	type PluginStatusAction,
} from '../../../../runtime'
import { buildStartPlan, executeStartPlan } from '../../pluginStatusActions'
import { invalidate } from '../../../data/invalidations'
import { usePluginScope } from '../context'
import { PLUGIN_DETAIL_HOTKEYS, PLUGIN_DETAIL_HOTKEY_LABELS } from '../../../workbench/shortcuts'

export interface ActionBarProps {
	onStatusUpdated?: () => Promise<void> | void
	compact?: boolean
	prominent?: boolean
}

const ACTION_LABEL: Record<PluginStatusAction, string> = {
	start: '启动',
	stop: '终止',
	restart: '重启',
	enable: '启用',
	disable: '禁用',
}

export function ActionBar({ onStatusUpdated, compact = false, prominent = false }: ActionBarProps) {
	const transport = useRuntimeTransportClient()
	const {
		pluginName,
		dependencies,
		knownPluginNames,
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

	const syncAfterSuccess = useCallback(
		async (action: PluginStatusAction) => {
			await refetch()
			await onStatusUpdated?.()
			invalidate({ topic: 'plugin-status', pluginName, reason: action })
		},
		[onStatusUpdated, pluginName, refetch],
	)

	const performAction = async (action: PluginStatusAction) => {
		if (!pluginName) return
		const mySeq = ++seqRef.current

		// ① 全局乐观：立即写入运行/同步态
		applyOptimistic(action)
		setIsLoading(true)

		try {
			const res = await transport.withRpc((rpc) => runPluginStatusAction(rpc, pluginName, action))
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
			await syncAfterSuccess(action)

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

	const cascadeStart = async (deps: string[], action: PluginStatusAction) => {
		if (!pluginName) return
		const mySeq = ++seqRef.current
		setIsLoading(true)

		try {
			const plan = await buildStartPlan([...deps, pluginName], {
				includeTargets: true,
				includeRunningTargets: action === 'restart',
				requireConfiguredFor: 'dependencies',
			})

			if (plan.missing.length > 0) {
				notify({
					title: '部分依赖未找到',
					message: `已跳过：${plan.missing.join('，')}`,
					color: 'yellow',
				})
			}

			if (plan.blockedByConfig.length > 0) {
				notify({
					title: '级联启动已取消',
					message: `以下依赖尚未配置：${plan.blockedByConfig.join('，')}`,
					color: 'yellow',
				})
				return
			}

			if (plan.order.length === 0) {
				if (plan.missing.length === 0) {
					notify({
						title: '依赖已就绪',
						message: '所有依赖均已运行，无需级联启动。',
						color: 'blue',
					})
				}
				return
			}

			const results = await executeStartPlan(plan.order, action === 'restart' ? 'restart' : 'start')
			if (mySeq !== seqRef.current) return
			const failed = results.filter((r) => !r.ok)
			if (failed.length > 0) {
				notify({
					title: '部分依赖启动失败',
					message: failed.map((f) => f.name).join('，') || '启动失败',
					color: 'red',
				})
				await refetch()
				return
			}

			await syncAfterSuccess(action)
			notify({
				title: '已级联启动',
				message: `已按依赖顺序${ACTION_LABEL[action]}：${plan.order.join(' → ')}`,
				color: 'green',
			})
		} catch (e: any) {
			if (mySeq !== seqRef.current) return
			notify({
				title: '级联启动失败',
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
		const isKnownPlugin = (name: string) => {
			if (knownPluginNames.has(name)) return true
			const hash = name.lastIndexOf('#')
			return hash > 0 ? knownPluginNames.has(name.slice(0, hash)) : false
		}
		const missing = needsDependencyCheck
			? dependencies
					.filter((d) => !d.isRunning)
					.map((d) => d.name)
					.filter((name): name is string => Boolean(name && isKnownPlugin(name)))
			: []

		const proceed = (): void => {
			void performAction(action)
		}

		if (missing.length > 0) {
			openConfirmModal({
				title: '前置依赖未启动',
				children: (
					<div>
						<div>可尝试级联启动已配置的依赖链，然后启动当前插件。</div>
						<div style={{ marginTop: 10 }}>以下依赖尚未运行：{missing.join('，')}</div>
					</div>
				),
				labels: { confirm: '级联启动', cancel: '取消' },
				onConfirm: () => void cascadeStart(missing, action),
				closeOnConfirm: true,
			})
		} else {
			proceed()
		}
	}

	const busy = isLoading || isSyncing
	const canToggle = !busy
	const persistDisabled = busy
	const iconSize = compact ? 16 : 18
	const actionSize = compact ? 'md' : 'lg'
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

				<Tooltip label={busy ? '同步中…' : '启动'}>
					<Button
						className="plx-pluginWorkbench__actionButton plx-pluginWorkbench__actionButton--primary"
						variant="filled"
						size="sm"
						leftSection={<IconPlayerPlay size={16} />}
						onClick={() => handleAction('start')}
						disabled={!canToggle || isRunning}
					>
						启动
					</Button>
				</Tooltip>

				<Tooltip label={busy ? '同步中…' : '终止'}>
					<Button
						className="plx-pluginWorkbench__actionButton"
						variant="light"
						color="red"
						size="sm"
						leftSection={<IconSquareX size={16} />}
						onClick={() => handleAction('stop')}
						disabled={!canToggle || !isRunning}
					>
						终止
					</Button>
				</Tooltip>

				<Tooltip label={busy ? '同步中…' : '重启 (Ctrl/⌘ + Alt + R)'}>
					<Button
						className="plx-pluginWorkbench__actionButton"
						variant="default"
						size="sm"
						leftSection={<IconRotateClockwise size={16} />}
						onClick={() => handleAction('restart')}
						disabled={!canToggle || !isRunning}
					>
						重启
						<span className="plx-pluginWorkbench__actionKeyHint">
							{PLUGIN_DETAIL_HOTKEY_LABELS.restartPlugin}
						</span>
					</Button>
				</Tooltip>

				<ExtensionSlot point="plugin:actions" fallback={null} />
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
			<ExtensionSlot point="plugin:actions" fallback={null} />

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

			<Tooltip label={busy ? '同步中…' : '启动'}>
				<ActionIcon
					variant="light"
					size={actionSize}
					onClick={() => handleAction('start')}
					disabled={!canToggle || isRunning}
				>
					<IconPlayerPlay size={iconSize} />
				</ActionIcon>
			</Tooltip>

			<Tooltip label={busy ? '同步中…' : '终止'}>
				<ActionIcon
					variant="light"
					size={actionSize}
					color="red"
					onClick={() => handleAction('stop')}
					disabled={!canToggle || !isRunning}
				>
					<IconSquareX size={iconSize} />
				</ActionIcon>
			</Tooltip>

			<Tooltip label={busy ? '同步中…' : '重启 (Ctrl/⌘ + Alt + R)'}>
				<ActionIcon
					variant="light"
					size={actionSize}
					color="green"
					onClick={() => handleAction('restart')}
					disabled={!canToggle || !isRunning}
				>
					<IconRotateClockwise size={iconSize} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}
