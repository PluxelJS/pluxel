// Provider-owned session UI for the interaction demo.

import { Paper, Select, Stack, Text } from '@mantine/core'
import { definePluginUIModule, type InteractionSessionComponentProps } from '@pluxel/runtime/web/ui'
import type {
	FontPickerDraft,
	FontPickerInput,
	FontPickerResult,
} from '../../PluginContributionFontDemo.shared'
import { plugin } from './runtime'

type FontOption = {
	value: string
	label: string
	description: string
	previewText: string
}

function FontPickerSession({
	targetPlugin,
	draft,
	setDraft,
	pushDraft,
	commit,
	disabled,
}: InteractionSessionComponentProps<
	FontPickerInput,
	FontPickerDraft,
	unknown,
	FontPickerResult
>) {
	const app = plugin.use()
	const collection = app.db.collection('fontSets').useView()
	const options: FontOption[] = app.db
		.collection('fontSets')
		.useList({ sort: { name: 1 } })
		.map((item) => ({
			value: item.id,
			label: item.name,
			description: item.description,
			previewText: item.previewText,
		}))

	const selected = options.find((item) => item.value === draft.selectedId) ?? null
	const handleChange = async (nextValue: string | null) => {
		const next = nextValue == null ? null : findOption(options, nextValue)
		const nextDraft = {
			selectedId: next?.value ?? null,
		} satisfies FontPickerDraft
		setDraft(nextDraft)
		await pushDraft(nextDraft)
		await commit(toCommitResult(next))
	}

	return (
		<Paper withBorder radius="md" p="sm" shadow="xs">
			<Stack gap="xs">
				<Select
					size="sm"
					label="Font Set"
					description={`这个交互面板由 font manager 提供，最终写回 ${targetPlugin}.appearance.fontSetRef`}
					placeholder="选择一个字体集"
					data={options.map((option) => ({
						value: option.value,
						label: option.label,
					}))}
					value={draft.selectedId}
					onChange={(nextValue) => void handleChange(nextValue)}
					disabled={disabled || !collection.ready}
					clearable
					searchable
					nothingFoundMessage="暂无字体集"
				/>
				{selected ? (
					<>
						<Text size="xs" c="dimmed">
							{selected.description}
						</Text>
						<Text size="sm" fw={500}>
							{selected.previewText}
						</Text>
					</>
				) : null}
			</Stack>
		</Paper>
	)
}

export default definePluginUIModule({
	sessions: {
		fontPickerSession: FontPickerSession,
	},
})

function findOption(options: FontOption[], value: string) {
	return options.find((item) => item.value === value) ?? null
}

function toCommitResult(option: FontOption | null): FontPickerResult {
	if (!option) return { type: 'clear-font' }
	return {
		type: 'set-font',
		ref: {
			provider: 'PluginContributionFontManager',
			kind: 'font-set',
			id: option.value,
			label: option.label,
		},
	}
}
