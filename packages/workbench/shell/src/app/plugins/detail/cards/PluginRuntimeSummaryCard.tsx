import {
	ActionIcon,
	Badge,
	Button,
	CopyButton,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
} from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconCopy } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import type { PluginStatusEntry } from '../../pluginOverview'
import { describePluginRuntime } from '../../pluginExecutionPresentation'
import { describePluginControl } from '../controls/pluginControlModel'

export function PluginRuntimeSummaryCard({
	status,
	description,
}: {
	status: PluginStatusEntry
	description?: string
}) {
	const control = describePluginControl(status)
	const { canonicalReference, definition, execution, recentUpdate } = describePluginRuntime(status)
	const updateWarning = recentUpdate.warning
	const diagnostic = JSON.stringify(
		{
			reference: canonicalReference,
			execution: status.execution,
			recentUpdate: status.recentUpdate
				? {
						batch: status.recentUpdate.batch,
						lifecycle: status.recentUpdate.lifecycle
							? {
									issues: status.recentUpdate.lifecycle.issues.map(
										({ phase, kind, blockedBy }) => ({ phase, kind, blockedBy }),
									),
								}
							: null,
					}
				: null,
			autoStart: status.autoStart,
			sessionIntent: status.sessionIntent,
			desiredState: status.desiredState,
			activationReason: status.activationReason,
			lifecycleState: status.lifecycleState,
			availability: status.availability,
			issueCodes: status.issues.map((issue) => issue.code),
		},
		null,
		2,
	)

	return (
		<Paper withBorder radius="sm" p="sm" shadow="none">
			<Stack gap={8}>
				{description ? (
					<Text size="xs" c="dimmed">
						{description}
					</Text>
				) : null}
				<SummaryRow label="当前状态">
					<Tooltip
						label={`${control.desiredStateLabel}；${control.sessionIntentLabel}；${control.activationReasonLabel}`}
					>
						<Badge size="xs" variant="light" color={control.statusTone}>
							{control.statusLabel}
						</Badge>
					</Tooltip>
				</SummaryRow>
				<SummaryRow label="来源">
					<Tooltip label={definition.detailLabel} multiline maw={360}>
						<Text size="xs" className="plx-pluginWorkbench__summaryText">
							{definition.compactLabel}
						</Text>
					</Tooltip>
					<CopyButton value={canonicalReference}>
						{({ copied, copy }) => (
							<Tooltip label={copied ? '已复制插件引用' : '复制插件引用'}>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="gray"
									aria-label="复制插件引用"
									onClick={copy}
								>
									{copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
								</ActionIcon>
							</Tooltip>
						)}
					</CopyButton>
				</SummaryRow>

				{updateWarning ? (
					<Group
						gap={6}
						wrap="nowrap"
						align="flex-start"
						className="plx-pluginWorkbench__statusIssues"
						role="status"
					>
						<IconAlertTriangle size={14} aria-hidden="true" style={{ flexShrink: 0 }} />
						<Text size="xs" c={recentUpdate.tone}>
							{recentUpdate.label}
						</Text>
					</Group>
				) : null}
				{recentUpdate.details.length > 0 ? (
					<Stack gap={4}>
						{recentUpdate.details.map((detail, index) => (
							<Text key={index} size="xs">
								{detail}
							</Text>
						))}
						<Text size="xs" c="dimmed">
							以上为上次更新记录；是否已恢复请看当前状态。
						</Text>
					</Stack>
				) : null}

				{status.issues.length > 0 ? (
					<Stack gap={4} className="plx-pluginWorkbench__statusIssues">
						{status.issues.map((issue) => (
							<Text key={issue.id} size="xs">
								{issue.message}
							</Text>
						))}
					</Stack>
				) : null}

				<details className="plx-pluginWorkbench__diagnostics" key={canonicalReference}>
					<summary>调试信息</summary>
					<Stack gap={8} mt={8}>
						<SummaryRow label="引用">{canonicalReference}</SummaryRow>
						<SummaryRow label="执行">
							{execution.currentLabel} · {execution.artifactLabel}
						</SummaryRow>
						<SummaryRow label="更新">{execution.updateLabel}</SummaryRow>
						<SummaryRow label="会话">
							{control.sessionIntentLabel} · {control.activationReasonLabel}
						</SummaryRow>
						<SummaryRow label="启动">
							自动启动{status.autoStart ? '已开启' : '已关闭'} · {control.desiredStateLabel}
						</SummaryRow>
						{status.recentUpdate ? (
							<SummaryRow label="本插件上次更新">
								{recentUpdate.label}
								{recentUpdate.meta ? ` · ${recentUpdate.meta}` : ''}
							</SummaryRow>
						) : null}
						{recentUpdate.batchLabel ? (
							<SummaryRow label="所属更新批次">{recentUpdate.batchLabel}</SummaryRow>
						) : null}
						<CopyButton value={diagnostic}>
							{({ copied, copy }) => (
								<Button size="compact-xs" variant="subtle" onClick={copy}>
									{copied ? '已复制诊断信息' : '复制诊断信息'}
								</Button>
							)}
						</CopyButton>
					</Stack>
				</details>
			</Stack>
		</Paper>
	)
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="plx-pluginWorkbench__summaryRow">
			<span className="plx-pluginWorkbench__summaryLabel">{label}</span>
			<div className="plx-pluginWorkbench__summaryValue">{children}</div>
		</div>
	)
}
