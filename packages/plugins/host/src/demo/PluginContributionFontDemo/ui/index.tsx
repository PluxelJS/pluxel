import { Paper, Select, Stack, Text } from '@mantine/core'
import { useEffect, useMemo, useState } from 'react'
import {
	FONT_KIND,
	FONT_MANAGER_PLUGIN_NAME,
	type FontRef,
} from '../../PluginContributionFontDemo.shared'
import { fontManager, fontSettings } from './runtime'

export function FontSettings() {
	const provider = fontManager.use()
	const consumer = fontSettings.use()
	const settings = consumer.api('settings')
	const fontSets = provider.collection('fontSets').useList({ sort: { name: 1 } })
	const [selected, setSelected] = useState<string | null>(null)

	useEffect(() => {
		let active = true
		void settings.current().then((font): undefined => {
			if (active) setSelected(font?.id ?? null)
			return undefined
		})
		return () => {
			active = false
		}
	}, [settings])

	const options = useMemo(
		() => fontSets.map((font) => ({ value: font.id, label: font.name })),
		[fontSets],
	)
	const selectedFont = fontSets.find((font) => font.id === selected)

	const update = async (id: string | null) => {
		setSelected(id)
		const font = fontSets.find((item) => item.id === id)
		const ref: FontRef | null = font
			? { provider: FONT_MANAGER_PLUGIN_NAME, kind: FONT_KIND, id: font.id, label: font.name }
			: null
		await settings.set(ref)
	}

	return (
		<Paper withBorder radius="md" p="sm" shadow="xs">
			<Stack gap="xs">
				<Select
					size="sm"
					label="Font Set"
					description={`renderer 来自 ${provider.owner}，配置写回 ${consumer.target}`}
					placeholder="选择一个字体集"
					data={options}
					value={selected}
					onChange={(value) => void update(value)}
					clearable
					searchable
				/>
				{selectedFont ? <Text size="sm">{selectedFont.previewText}</Text> : null}
			</Stack>
		</Paper>
	)
}

export default fontManager.define({ FontSettings })
