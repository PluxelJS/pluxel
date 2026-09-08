import { Badge, Button, Group, Popover, Stack, Text } from '@mantine/core'
import type { RuntimeUpdateSnapshot } from '@pluxel/runtime/web'
import { IconCircleCheck, IconLoader2, IconRefresh, IconAlertTriangle } from '@tabler/icons-react'
import { useRuntimeUpdates } from '../../runtimeUpdates'
import { useRuntimeMeta } from '../../product'

const PHASE_LABELS = {
	evaluate: '加载候选版本',
	artifacts: '准备界面产物',
	inject: '校验插件目录',
	commit: '提交运行版本',
	lifecycle: '启动插件与依赖',
	'application-reload': '重新载入应用',
} satisfies Record<NonNullable<RuntimeUpdateSnapshot['phase']>, string>

export function WorkbenchUpdateStatus() {
	const { snapshot, ready, error } = useRuntimeUpdates()
	const meta = useRuntimeMeta()
	if (meta?.platform.mode === 'production' && !snapshot) return null
	const updating = snapshot?.state === 'updating'
	const preparing =
		snapshot?.phase === 'evaluate' ||
		snapshot?.phase === 'artifacts' ||
		snapshot?.phase === 'inject'
	const restored = snapshot?.outcome === 'restored-previous'
	const retained = snapshot?.outcome === 'retained-previous'
	const issues =
		restored || retained || snapshot?.outcome === 'applied-with-issues' || Boolean(error)
	const color = issues ? 'yellow' : updating ? 'blue' : 'teal'
	const label = error
		? 'HMR 状态不可用'
		: updating
			? 'HMR 更新中'
			: restored
				? 'HMR 已恢复旧版'
				: retained
					? 'HMR 保留旧版'
					: issues
						? 'HMR 存在问题'
						: snapshot
							? 'HMR 已应用'
							: ready
								? 'HMR 就绪'
								: 'HMR 连接中'
	const Icon = issues
		? IconAlertTriangle
		: updating
			? IconLoader2
			: snapshot
				? IconCircleCheck
				: IconRefresh
	return (
		<Popover width={360} position="bottom-end" withArrow shadow="md">
			<Popover.Target>
				<Button
					className="plx-workbench__updateStatus"
					variant="subtle"
					color={color}
					size="compact-xs"
					leftSection={<Icon size={15} aria-hidden="true" />}
					aria-label={`${label}，查看更新详情`}
				>
					<span role="status" aria-live="polite">
						{label}
					</span>
				</Button>
			</Popover.Target>
			<Popover.Dropdown style={{ maxWidth: 'calc(100vw - 24px)' }}>
				<Stack gap="xs">
					<Group justify="space-between">
						<Text fw={600} size="sm">
							开发热更新
						</Text>
						{snapshot ? (
							<Badge color={color} variant="light">
								批次 #{snapshot.sequence}
							</Badge>
						) : null}
					</Group>
					<Text size="sm">
						{error ??
							(updating
								? preparing
									? '正在准备新版本，当前版本继续提供服务。'
									: '正在切换运行版本，部分服务可能暂时不可用。'
								: restored
									? '已使用上一应用定义重新建立服务。具体可用性请查看插件当前状态。'
									: retained
										? '本次更新未应用，上一版本继续提供服务。修正错误后会自动重试。'
										: issues
											? '新版本已应用，但本次更新仍有待处理的问题。请查看批次原因与插件当前状态。'
											: snapshot
												? '最近批次已应用。界面产物就绪后会自动载入，具体可用性请查看对应页面。'
												: '更新状态已连接，目前暂无更新记录。')}
					</Text>
					{snapshot ? (
						<>
							<Text size="xs" c="dimmed">
								{snapshot.phase ? PHASE_LABELS[snapshot.phase] : '已完成'} ·{' '}
								{Math.round(snapshot.durationMs)} ms
							</Text>
							{snapshot.trigger ? (
								<Text size="xs" style={{ overflowWrap: 'anywhere' }}>
									变更：{snapshot.trigger}
								</Text>
							) : null}
							{snapshot.error ? (
								<Stack gap={4}>
									<Text
										size="sm"
										c="red"
										style={{
											whiteSpace: 'pre-wrap',
											overflowWrap: 'anywhere',
											maxHeight: 180,
											overflowY: 'auto',
										}}
									>
										{snapshot.error.message}
									</Text>
									{snapshot.error.file ? (
										<Text size="xs" style={{ overflowWrap: 'anywhere' }}>
											失败文件：{snapshot.error.file}
										</Text>
									) : null}
									{snapshot.error.importChain.length > 0 ? (
										<Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
											导入链：{snapshot.error.importChain.join(' → ')}
										</Text>
									) : null}
								</Stack>
							) : null}
						</>
					) : null}
				</Stack>
			</Popover.Dropdown>
		</Popover>
	)
}
