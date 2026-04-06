import { Paper, Select, Stack, Text } from '@mantine/core'
import { definePluginUIModule, type InteractionSessionComponentProps } from '@pluxel/runtime/web/ui'
import { plugin } from './runtime'

type FontPickerDraft = {
	selectedId: string | null
}

function FontPickerSession({
	targetPlugin,
	draft,
	setDraft,
	pushDraft,
	commit,
	disabled,
}: InteractionSessionComponentProps<
	{ current: { id: string; label?: string } | null },
	FontPickerDraft,
	unknown,
	| { type: 'set-font'; ref: { provider: string; kind: 'font-set'; id: string; label?: string } }
	| { type: 'clear-font' }
>) {
	const app = plugin.use()
	const collection = app.db.collection('fontSets').useView()
	const options = app.db
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
		const next =
			nextValue == null ? null : (options.find((item) => item.value === nextValue) ?? null)
		const nextDraft = {
			selectedId: next?.value ?? null,
		} satisfies FontPickerDraft
		setDraft(nextDraft)
		await pushDraft(nextDraft)
		await commit(
			next
				? {
						type: 'set-font',
						ref: {
							provider: 'PluginContributionFontManager',
							kind: 'font-set',
							id: next.value,
							label: next.label,
						},
					}
				: {
						type: 'clear-font',
					},
		)
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
