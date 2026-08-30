import { Alert, MantineProvider, Paper, Select, Stack, Text } from '@mantine/core'
import '@mantine/core/styles.css'
import { useWorkbench } from '@pluxel/runtime/workbench/react'
import { useEffect, useMemo, useState } from 'react'
import { FontManagerWorkbench } from '../../PluginContributionFontDemo.workbench'
import {
	FONT_KIND,
	FONT_MANAGER_PLUGIN_NAME,
	type FontRef,
	type FontSet,
} from '../../PluginContributionFontDemo.shared'

export default function FontSettings() {
	const { provider, consumer, host } = useWorkbench(FontManagerWorkbench.selection)
	const [fonts, setFonts] = useState<readonly FontSet[]>([])
	const [selected, setSelected] = useState<string | null>(null)
	const [error, setError] = useState<string>()

	useEffect(() => {
		let active = true
		void (async () => {
			let rawFonts: Awaited<ReturnType<typeof provider.list>> | undefined
			let rawSelection: Awaited<ReturnType<typeof consumer.current>> | undefined
			try {
				rawFonts = await provider.list()
				rawSelection = await consumer.current()
				if (!active) return
				setFonts(
					Object.freeze(
						rawFonts.map((font) =>
							Object.freeze({
								id: font.id,
								name: font.name,
								previewText: font.previewText,
								description: font.description,
							}),
						),
					),
				)
				setSelected(rawSelection?.id ?? null)
				setError(undefined)
			} catch (caught) {
				if (active) setError(messageOf(caught))
			} finally {
				dispose(rawFonts)
				dispose(rawSelection)
			}
		})()
		return () => {
			active = false
		}
	}, [consumer, provider])

	const options = useMemo(
		() => fonts.map((font) => ({ value: font.id, label: font.name })),
		[fonts],
	)
	const selectedFont = fonts.find((font) => font.id === selected)
	const update = async (id: string | null) => {
		const font = fonts.find((item) => item.id === id)
		const ref: FontRef | null = font
			? Object.freeze({
					provider: FONT_MANAGER_PLUGIN_NAME,
					kind: FONT_KIND,
					id: font.id,
					label: font.name,
				})
			: null
		let result: Awaited<ReturnType<typeof consumer.set>> | undefined
		try {
			result = await consumer.set(ref)
			setSelected(result?.id ?? null)
			setError(undefined)
		} catch (caught) {
			setError(messageOf(caught))
		} finally {
			dispose(result)
		}
	}

	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Stack gap="xs">
					{error ? <Alert color="red">{error}</Alert> : null}
					<Select
						size="sm"
						label="Font Set"
						description="Attachment provider supplies choices; the consumer owns selection."
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
		</MantineProvider>
	)
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function dispose(value: unknown): void {
	const action =
		value && (typeof value === 'object' || typeof value === 'function')
			? (value as Partial<Disposable>)[Symbol.dispose]
			: undefined
	if (typeof action === 'function') action.call(value)
}
