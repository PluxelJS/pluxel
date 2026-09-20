import { Badge, Button, Group, Select, Text, Tooltip } from '@mantine/core'
import { IconDeviceFloppy, IconRestore } from '@tabler/icons-react'
import { PLUGIN_DETAIL_HOTKEY_LABELS } from '../../../workbench/shortcuts'

type ActiveState = {
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
}

export function ConfigActionDock({
	activeKey,
	activeLabel,
	activeState,
	dirtyLabels,
	hasMultipleSections,
	savingScope,
	canSaveAll,
	sectionOptions,
	onActiveKeyChange,
	onSubmitCurrent,
	onSubmitAll,
	onResetCurrent,
	onResetDefaults,
}: {
	activeKey: string
	activeLabel: string
	activeState: ActiveState
	dirtyLabels: string[]
	hasMultipleSections: boolean
	savingScope?: 'current' | 'all'
	canSaveAll: boolean
	sectionOptions: Array<{ value: string; label: string }>
	onActiveKeyChange: (key: string) => void
	onSubmitCurrent: () => void
	onSubmitAll: () => void
	onResetCurrent: () => void
	onResetDefaults: () => void
}) {
	const saving = savingScope !== undefined
	const dirtyCount = dirtyLabels.length
	const dirtyLabel =
		dirtyCount > 0
			? `${dirtyLabels.slice(0, 3).join('、')}${dirtyCount > 3 ? `，另有 ${dirtyCount - 3} 项` : ''}`
			: '没有未保存的配置'

	return (
		<div className="plx-pluginWorkbench__configActionDock">
			<div className="plx-pluginWorkbench__configActionSummary">
				{hasMultipleSections ? (
					<div className="plx-pluginWorkbench__configActionSelect">
						<Select
							size="xs"
							value={activeKey}
							data={sectionOptions}
							onChange={(value) => {
								if (typeof value === 'string' && value) onActiveKeyChange(value)
							}}
							allowDeselect={false}
							searchable={sectionOptions.length > 6}
							placeholder="当前配置分区"
							aria-label="选择配置分区"
							nothingFoundMessage="没有可选项"
						/>
					</div>
				) : (
					<Text fw={600} size="sm" className="plx-pluginWorkbench__configActionKey">
						{activeLabel}
					</Text>
				)}
				<span aria-live="polite">
					{dirtyCount > 0 ? (
						<Tooltip label={dirtyLabel} withArrow>
							<Badge variant="light" color="yellow">
								待保存 {dirtyCount}
							</Badge>
						</Tooltip>
					) : (
						<Badge variant="light" color="green">
							已保存
						</Badge>
					)}
				</span>
				<Text size="xs" c="dimmed" className="plx-pluginWorkbench__configShortcutHint">
					{PLUGIN_DETAIL_HOTKEY_LABELS.saveCurrentConfig} 保存
					{hasMultipleSections ? ` · ${PLUGIN_DETAIL_HOTKEY_LABELS.saveAllConfig} 全部` : ''}
				</Text>
			</div>

			<Group
				gap="xs"
				wrap="wrap"
				justify="flex-end"
				className="plx-pluginWorkbench__configActionButtons"
			>
				<Button
					type="button"
					size="xs"
					variant="default"
					onClick={onResetCurrent}
					disabled={!activeState.dirty || activeState.submitting || saving}
				>
					撤销
				</Button>
				<Button
					type="button"
					size="xs"
					variant="subtle"
					leftSection={<IconRestore size={14} />}
					onClick={onResetDefaults}
					disabled={activeState.submitting || saving}
				>
					恢复默认
				</Button>
				<Button
					type="button"
					size="xs"
					leftSection={<IconDeviceFloppy size={14} />}
					onClick={onSubmitCurrent}
					loading={activeState.submitting}
					disabled={!activeState.dirty || !activeState.canSubmit || saving}
					title="保存当前配置 (Ctrl/⌘ + S)"
				>
					保存
				</Button>
				{hasMultipleSections ? (
					<Button
						type="button"
						size="xs"
						variant="light"
						onClick={onSubmitAll}
						loading={savingScope === 'all'}
						disabled={dirtyCount === 0 || saving || !canSaveAll}
						title="保存全部已修改配置 (Ctrl/⌘ + Shift + S)"
					>
						全部保存
					</Button>
				) : null}
			</Group>
		</div>
	)
}
