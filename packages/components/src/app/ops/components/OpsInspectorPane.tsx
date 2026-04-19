import { Badge, Button, Code, Group, Paper, Stack, Text, Textarea } from '@mantine/core'
import { IconPlayerPlay, IconStack2 } from '@tabler/icons-react'
import type { RuntimeOpCatalogEntry } from '@pluxel/runtime/web'
import { InlineNotice } from '../../../components'
import type { OpsExplorerSelection } from '../model'
import type { RunResult } from '../types'
import { getOwnerDisplay, getRunTone } from '../view'
import { OpsPanel, OpsPanelEmpty, OpsPanelScroll, OpsRunResultCard } from './OpsPanel'

type ToolsetBadge = {
	name: string
	toolsetId: string
}

export function OpsInspectorPane({
	activeDraft,
	activeEntry,
	activeInputMode,
	activeResult,
	activeToolsets,
	busyId,
	catalogMissingOpIds,
	onAssignToolsets,
	onCancelPrepared,
	onDraftChange,
	onPrepareEntry,
	onRunEntry,
	preparedEntryId,
	selection,
}: {
	activeDraft: string
	activeEntry: RuntimeOpCatalogEntry | null
	activeInputMode: 'json-object' | 'none' | 'unsupported'
	activeResult?: RunResult
	activeToolsets: ToolsetBadge[]
	busyId: string | null
	catalogMissingOpIds: string[]
	onAssignToolsets: (opIds: string[]) => void
	onCancelPrepared: () => void
	onDraftChange: (value: string) => void
	onPrepareEntry: (entry: RuntimeOpCatalogEntry) => void
	onRunEntry: (entry: RuntimeOpCatalogEntry) => void
	preparedEntryId: string | null
	selection: OpsExplorerSelection
}) {
	return (
		<OpsPanel
			header={
				<>
					<Text fw={700} size="sm">
						Inspector
					</Text>
					<Text size="xs" c="dimmed">
						详情、执行输入和最近结果都集中在这里，不再撑大主列表。
					</Text>
				</>
			}
		>
			<OpsPanelScroll>
				{activeEntry ? (
					<Stack gap="sm" p="sm">
						<Stack gap={4}>
							<Text fw={700}>{activeEntry.descriptor.doc.title ?? activeEntry.id}</Text>
							<Text size="sm" c="dimmed">
								{activeEntry.descriptor.doc.description ?? activeEntry.id}
							</Text>
							<Group gap={6} wrap="wrap">
								<Code>{activeEntry.id}</Code>
								<Badge size="xs" variant="light" color="gray">
									{getOwnerDisplay(activeEntry)}
								</Badge>
								{activeEntry.descriptor.transports.tool ? (
									<Badge size="xs" variant="light" color="blue">
										Tool
									</Badge>
								) : null}
								{activeEntry.descriptor.transports.cli ? (
									<Badge size="xs" variant="light" color="gray">
										CLI
									</Badge>
								) : null}
							</Group>
						</Stack>

						<Paper withBorder radius="md" p="sm">
							<Stack gap={6}>
								<Text size="xs" fw={700} c="dimmed" tt="uppercase">
									Toolset 归属
								</Text>
								{activeToolsets.length === 0 ? (
									<Text size="sm" c="dimmed">
										当前未加入任何 toolset。
									</Text>
								) : (
									<Group gap={6} wrap="wrap">
										{activeToolsets.map((toolset) => (
											<Badge key={toolset.toolsetId} size="sm" variant="light" color="brand">
												{toolset.name}
											</Badge>
										))}
									</Group>
								)}
								<Button
									size="xs"
									variant="light"
									leftSection={<IconStack2 size={14} />}
									onClick={() => onAssignToolsets([activeEntry.id])}
								>
									管理 Toolset
								</Button>
							</Stack>
						</Paper>

						{selection.kind === 'toolset' && catalogMissingOpIds.length > 0 ? (
							<InlineNotice title="当前 toolset 里有暂时不可用的 op">
								<Group gap={6} wrap="wrap">
									{catalogMissingOpIds.map((opId) => (
										<Code key={opId}>{opId}</Code>
									))}
								</Group>
							</InlineNotice>
						) : null}

						{activeEntry.descriptor.transports.cli?.usage ? (
							<Paper withBorder radius="md" p="sm">
								<Stack gap={4}>
									<Text size="xs" fw={700} c="dimmed" tt="uppercase">
										CLI
									</Text>
									<Code block>{activeEntry.descriptor.transports.cli.usage}</Code>
								</Stack>
							</Paper>
						) : null}

						<Paper withBorder radius="md" p="sm">
							<Stack gap="sm">
								<Text size="xs" fw={700} c="dimmed" tt="uppercase">
									执行
								</Text>
								{activeEntry.descriptor.policy.mutating || activeEntry.descriptor.policy.confirm ? (
									<InlineNotice title="这个 op 会触发真实动作">
										<Text size="sm" c="dimmed">
											{activeEntry.descriptor.policy.confirm
												? '执行前会要求确认。'
												: '执行后会修改宿主状态或插件状态。'}
										</Text>
									</InlineNotice>
								) : null}

								{activeInputMode === 'none' ? (
									<Button
										leftSection={<IconPlayerPlay size={14} />}
										color={getRunTone(activeEntry)}
										loading={busyId === activeEntry.id}
										onClick={() => {
											void onRunEntry(activeEntry)
										}}
									>
										直接执行
									</Button>
								) : null}

								{activeInputMode === 'json-object' ? (
									<>
										{preparedEntryId === activeEntry.id ? (
											<>
												<Textarea
													label="执行输入"
													size="xs"
													minRows={8}
													autosize
													value={activeDraft}
													onChange={(event) => onDraftChange(event.currentTarget.value)}
													classNames={{ input: 'plx-opsMonospaceInput' }}
												/>
												<Group gap="xs">
													<Button
														leftSection={<IconPlayerPlay size={14} />}
														color={getRunTone(activeEntry)}
														loading={busyId === activeEntry.id}
														onClick={() => {
															void onRunEntry(activeEntry)
														}}
													>
														确认执行
													</Button>
													<Button variant="default" onClick={onCancelPrepared}>
														取消
													</Button>
												</Group>
											</>
										) : (
											<Button
												variant="light"
												leftSection={<IconPlayerPlay size={14} />}
												onClick={() => onPrepareEntry(activeEntry)}
											>
												准备执行
											</Button>
										)}
									</>
								) : null}

								{activeInputMode === 'unsupported' ? (
									<InlineNotice title="当前 UI 暂不支持该输入形态">
										<Text size="sm" c="dimmed">
											仅支持 object input op。其它输入形态仍可通过 CLI / MCP / 自定义客户端调用。
										</Text>
									</InlineNotice>
								) : null}
							</Stack>
						</Paper>

						{activeResult ? (
							<OpsRunResultCard result={activeResult} />
						) : (
							<Paper withBorder radius="md" p="sm">
								<Text size="sm" c="dimmed">
									还没有执行记录。执行后完整结果会显示在这里，主列表只保留紧凑状态。
								</Text>
							</Paper>
						)}
					</Stack>
				) : (
					<OpsPanelEmpty
						title="还没有选中操作"
						description="在中间列表点选一行，右侧就会切换到它的执行和结果面板。"
					/>
				)}
			</OpsPanelScroll>
		</OpsPanel>
	)
}
