import { Badge, Button, Checkbox, Divider, Group, Modal, Paper, Stack, Text, TextInput } from '@mantine/core'
import { useEffect, useMemo, useState } from 'react'
import type { OpsToolsetInput } from '@pluxel/runtime/web'

import { createOpsToolsetId, normalizeOpsToolsetName } from './model'

type AssignOpsToToolsetsModalProps = {
	opened: boolean
	opIds: string[]
	toolsets: OpsToolsetInput[]
	saving: boolean
	onClose: () => void
	onSave: (
		toolsets: OpsToolsetInput[],
		options?: { successTitle?: string; successMessage?: string },
	) => void
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values))
}

export function AssignOpsToToolsetsModal(props: AssignOpsToToolsetsModalProps) {
	const [draftToolsets, setDraftToolsets] = useState<OpsToolsetInput[]>(props.toolsets)
	const [newToolsetName, setNewToolsetName] = useState('')
	const [newToolsetDescription, setNewToolsetDescription] = useState('')

	useEffect(() => {
		if (!props.opened) return
		setDraftToolsets(
			props.toolsets.map((toolset) => ({
				...toolset,
				opIds: [...toolset.opIds],
			})),
		)
		setNewToolsetName('')
		setNewToolsetDescription('')
	}, [props.opened, props.toolsets])

	const count = props.opIds.length
	const label = count === 1 ? props.opIds[0] : `${count} 个 op`
	const selectedIds = useMemo(() => new Set(props.opIds), [props.opIds])

	const toggleToolset = (toolsetId: string, checked: boolean) => {
		setDraftToolsets((current) =>
			current.map((toolset) => {
				if (toolset.toolsetId !== toolsetId) return toolset
				const nextIds = checked
					? unique([...toolset.opIds, ...props.opIds])
					: toolset.opIds.filter((opId) => !selectedIds.has(opId))
				return {
					...toolset,
					opIds: nextIds,
				}
			}),
		)
	}

	const createAndAssignToolset = () => {
		const name = normalizeOpsToolsetName(newToolsetName)
		if (!name) return
		setDraftToolsets((current) => [
			...current,
			{
				toolsetId: createOpsToolsetId(),
				name,
				description: normalizeOpsToolsetName(newToolsetDescription) || undefined,
				opIds: [...props.opIds],
			},
		])
		setNewToolsetName('')
		setNewToolsetDescription('')
	}

	return (
		<Modal opened={props.opened} onClose={props.onClose} title="加入 Toolset" centered>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					把 {label} 加入一个或多个 toolset。取消勾选则会从对应 toolset 中移除。
				</Text>

				<Stack gap="xs">
					{draftToolsets.length === 0 ? (
						<Paper withBorder radius="md" p="sm">
							<Text size="sm" c="dimmed">
								还没有 toolset，先在下面新建一个。
							</Text>
						</Paper>
					) : (
						draftToolsets.map((toolset) => {
							const hitCount = props.opIds.filter((opId) => toolset.opIds.includes(opId)).length
							return (
								<Paper key={toolset.toolsetId} withBorder radius="md" p="sm">
									<Group justify="space-between" align="center" wrap="nowrap">
										<Checkbox
											checked={hitCount === props.opIds.length && props.opIds.length > 0}
											indeterminate={hitCount > 0 && hitCount < props.opIds.length}
											onChange={(event) =>
												toggleToolset(toolset.toolsetId, event.currentTarget.checked)
											}
											label={
												<Stack gap={2}>
													<Text size="sm" fw={600}>
														{toolset.name}
													</Text>
													{toolset.description ? (
														<Text size="xs" c="dimmed">
															{toolset.description}
														</Text>
													) : null}
													<Text size="xs" c="dimmed">
														当前共 {toolset.opIds.length} 个 op
													</Text>
												</Stack>
											}
										/>
										<Badge size="xs" variant="light" color="gray">
											{hitCount}/{props.opIds.length}
										</Badge>
									</Group>
								</Paper>
							)
						})
					)}
				</Stack>

				<Divider label="新建 Toolset" labelPosition="center" />

				<Stack gap="xs">
					<TextInput
						label="Toolset 名称"
						placeholder="例如：发布前检查、内容流水线、常用维护"
						value={newToolsetName}
						onChange={(event) => setNewToolsetName(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key !== 'Enter') return
							event.preventDefault()
							createAndAssignToolset()
						}}
					/>
					<TextInput
						label="用途描述"
						placeholder="给 LLM / Agent 的高层语义说明，例如：发布前用来检查状态、配置与依赖"
						value={newToolsetDescription}
						onChange={(event) => setNewToolsetDescription(event.currentTarget.value)}
					/>
					<Group justify="flex-end">
						<Button
							variant="light"
							onClick={createAndAssignToolset}
							disabled={!normalizeOpsToolsetName(newToolsetName)}
						>
							新建并加入
						</Button>
					</Group>
				</Stack>

				<Group justify="space-between" align="center">
					<Text size="xs" c="dimmed">
						toolset 只是宿主侧 metadata，不改变 runtime registry。
					</Text>
					<Group gap="xs">
						<Button variant="default" onClick={props.onClose}>
							取消
						</Button>
						<Button
							loading={props.saving}
							onClick={() =>
								props.onSave(draftToolsets, {
									successTitle: '已更新 Toolset',
									successMessage: label,
								})
							}
						>
							保存
						</Button>
					</Group>
				</Group>
			</Stack>
		</Modal>
	)
}
