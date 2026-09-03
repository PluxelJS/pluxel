import { Alert, MantineProvider, Paper, Select, Stack, Text } from '@mantine/core'
import { useMemo } from 'react'
import {
	FONT_KIND,
	FONT_MANAGER_PLUGIN_NAME,
	type FontRef,
} from '../../PluginContributionFontDemo.shared'
import { fontCatalog, fontSelection, selectionScope, setFontSelection } from './selection.scope'

function FontSettings() {
	const { host } = selectionScope.useWorkbench()
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<FontSettingsContent />
		</MantineProvider>
	)
}

function FontSettingsContent() {
	const catalogQuery = fontCatalog.useQuery()
	const selectionQuery = fontSelection.useQuery()
	const selectionMutation = setFontSelection.useMutation()
	const fonts = catalogQuery.data ?? []
	const selected = selectionQuery.data?.id ?? null

	const options = useMemo(
		() => fonts.map((font) => ({ value: font.id, label: font.name })),
		[fonts],
	)
	const selectedFont = fonts.find((font) => font.id === selected)
	const update = (id: string | null) => {
		const font = fonts.find((item) => item.id === id)
		const ref: FontRef | null = font
			? Object.freeze({
					provider: FONT_MANAGER_PLUGIN_NAME,
					kind: FONT_KIND,
					id: font.id,
					label: font.name,
				})
			: null
		selectionMutation.mutate(ref)
	}
	const error =
		selectionMutation.status === 'error'
			? selectionMutation.error
			: catalogQuery.status === 'error'
				? catalogQuery.error
				: selectionQuery.status === 'error'
					? selectionQuery.error
					: undefined

	return (
		<Paper withBorder radius="md" p="sm" shadow="xs">
			<Stack gap="xs">
				{error ? <Alert color="red">{messageOf(error)}</Alert> : null}
				<Select
					size="sm"
					label="Font Set"
					description="Attachment provider supplies choices; the consumer owns selection."
					placeholder="选择一个字体集"
					data={options}
					value={selected}
					disabled={catalogQuery.status === 'pending' || selectionMutation.isPending}
					onChange={update}
					clearable
					searchable
				/>
				{selectedFont ? <Text size="sm">{selectedFont.previewText}</Text> : null}
			</Stack>
		</Paper>
	)
}

export default selectionScope.render(FontSettings)

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
