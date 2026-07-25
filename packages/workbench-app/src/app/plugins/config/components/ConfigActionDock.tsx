import { Badge, Button, Group, Select, Text, Tooltip } from '@mantine/core'
import { PLUGIN_DETAIL_HOTKEY_LABELS } from '../../../workbench/shortcuts'
import { SavedStatus } from './SavedStatus'

type ActiveState = {
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
}

export function ConfigActionDock({
	activeKey,
	activeState,
	activeSavedAt,
	dirtyKeys,
	hasMultipleSchemas,
	savingAll,
	schemaOptions,
	onActiveKeyChange,
	onSubmitCurrent,
	onSubmitAll,
	onResetCurrent,
	onResetDefaults,
}: {
	activeKey: string
	activeState: ActiveState
	activeSavedAt?: number
	dirtyKeys: string[]
	hasMultipleSchemas: boolean
	savingAll: boolean
	schemaOptions: Array<{ value: string; label: string }>
	onActiveKeyChange: (key: string) => void
	onSubmitCurrent: () => void
	onSubmitAll: () => void
	onResetCurrent: () => void
	onResetDefaults: () => void
}) {
	const dirtyCount = dirtyKeys.length
	const dirtyLabel =
		dirtyCount > 0
			? `${dirtyKeys.slice(0, 3).join(', ')}${dirtyCount > 3 ? ` +${dirtyCount - 3}` : ''}`
			: '没有未保存的配置'

	return (
		<div className="plx-pluginWorkbench__configActionDock">
			<div className="plx-pluginWorkbench__configActionSummary">
				{schemaOptions.length > 0 ? (
					<div className="plx-pluginWorkbench__configActionSelect">
						<Select
							size="xs"
							value={activeKey}
							data={schemaOptions}
							onChange={(value) => {
								if (typeof value === 'string' && value) onActiveKeyChange(value)
							}}
							allowDeselect={false}
							searchable={schemaOptions.length > 6}
							placeholder="当前配置"
							aria-label="选择当前配置面板"
							nothingFoundMessage="没有可选项"
						/>
					</div>
				) : (
					<Text fw={600} size="sm" className="plx-pluginWorkbench__configActionKey">
						{activeKey}
					</Text>
				)}
				<SavedStatus dirty={activeState.dirty} savedAt={activeSavedAt} />
				{dirtyCount > 0 ? (
					<Tooltip label={dirtyLabel} withArrow>
						<Badge variant="light" color="yellow">
							已修改 {dirtyCount}
						</Badge>
					</Tooltip>
				) : (
					<Badge variant="light" color="green">
						全部已保存
					</Badge>
				)}
				<Text size="xs" c="dimmed">
					{PLUGIN_DETAIL_HOTKEY_LABELS.saveCurrentConfig} 保存
					{hasMultipleSchemas ? ` · ${PLUGIN_DETAIL_HOTKEY_LABELS.saveAllConfig} 全部` : ''}
				</Text>
			</div>

			<Group
				gap="xs"
				wrap="wrap"
				justify="flex-end"
				className="plx-pluginWorkbench__configActionButtons"
			>
				<Button
					size="xs"
					variant="default"
					onClick={onResetCurrent}
					disabled={!activeState.dirty || activeState.submitting}
				>
					撤销当前
				</Button>
				<Button
					size="xs"
					variant="subtle"
					onClick={onResetDefaults}
					disabled={activeState.submitting}
				>
					重置默认
				</Button>
				<Button
					size="xs"
					onClick={onSubmitCurrent}
					loading={activeState.submitting}
					disabled={!activeState.dirty || !activeState.canSubmit}
					title="保存当前配置 (Ctrl/⌘ + S)"
				>
					提交当前
				</Button>
				{hasMultipleSchemas ? (
					<Button
						size="xs"
						variant="light"
						onClick={onSubmitAll}
						loading={savingAll}
						disabled={dirtyCount === 0 || savingAll}
						title="保存全部已修改配置 (Ctrl/⌘ + Shift + S)"
					>
						提交全部
					</Button>
				) : null}
			</Group>
		</div>
	)
}
