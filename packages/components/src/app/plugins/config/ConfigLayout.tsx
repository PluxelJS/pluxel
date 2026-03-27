import { Box, Paper, Stack, Text, TypographyStylesProvider } from '@mantine/core'
import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { MarkdownExit } from 'markdown-exit'
import { ConfigTabContent } from './ConfigTab'
import { compareSchemaKeys } from './schemaKey'
import type { BuiltinMarkdownPart } from '@pluxel/runtime/web/extensions'

const mdEngine = new MarkdownExit({ html: false, linkify: true })

function compileMarkdownToHtml(text: string): string {
	const env: Record<string, unknown> = {}
	const tokens = mdEngine.parse(String(text ?? ''), env)
	return mdEngine.renderer.render(tokens, mdEngine.options, env)
}

function toRecord(value: unknown): Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	return value as Record<string, any>
}

export function ConfigLayout({
	pluginName,
	layout,
	schemas,
	savedConfig,
	defaults,
	active,
}: {
	pluginName: string
	layout: BuiltinMarkdownPart[]
	schemas: Record<string, ObjectSchema<any, any>>
	savedConfig: Record<string, unknown>
	defaults: Record<string, unknown>
	active: boolean
}) {
	const [savedOverride, setSavedOverride] = useState<Record<string, any> | null>(null)

	// Reset local baseline when external saved config changes.
	useEffect(() => {
		setSavedOverride(null)
	}, [layout, pluginName, savedConfig])

	const schemaKeys = useMemo(() => Object.keys(schemas ?? {}).sort(compareSchemaKeys), [schemas])

	const rendered = useMemo(() => {
		const used = new Set<string>()
		const chunks: Array<
			| { kind: 'md'; key: string; html: string }
			| { kind: 'schema'; key: string; schemaKey: string }
		> = []

		let idx = 0
		const parts = Array.isArray(layout) ? layout : []
		for (const part of parts) {
			idx += 1
			if (!part || typeof part !== 'object') continue

			if ((part as any).kind === 'md') {
				const html = compileMarkdownToHtml(String((part as any).text ?? ''))
				if (html.trim()) chunks.push({ kind: 'md', key: `md-${idx}`, html })
				continue
			}

			if (part.kind === 'schema') {
				const k = String(part.key ?? '').trim()
				if (!k || used.has(k)) continue
				used.add(k)
				chunks.push({ kind: 'schema', key: `schema-${k}`, schemaKey: k })
				continue
			}

			if (part.kind === 'schemas') {
				const listRaw = part.keys
				const list =
					listRaw == null
						? schemaKeys.filter((k) => !used.has(k))
						: Array.isArray(listRaw)
							? listRaw
							: []
				for (const schemaKey of list) {
					const k = String(schemaKey ?? '').trim()
					if (!k || used.has(k)) continue
					used.add(k)
					chunks.push({ kind: 'schema', key: `schema-${k}`, schemaKey: k })
				}
			}
		}

		const remaining = schemaKeys.filter((k) => !used.has(k))
		return { chunks, remaining }
	}, [layout, schemaKeys])

	const finalSavedConfig = (savedOverride ?? savedConfig) as Record<string, unknown>

	return (
		<Box style={{ flex: 1, minHeight: 0 }}>
			{rendered.chunks.length ? (
				<Box>
					<TypographyStylesProvider>
						{rendered.chunks.map((chunk) => {
							if (chunk.kind === 'md') {
								// biome-ignore lint/security/noDangerouslySetInnerHtml: markdown is plugin-authored source code.
								return <Box key={chunk.key} dangerouslySetInnerHTML={{ __html: chunk.html }} />
							}
							const schemaKey = chunk.schemaKey
							const schema = schemas?.[schemaKey]
							if (!schema) {
								return (
									<Paper key={chunk.key} withBorder radius="md" p="sm" my="sm">
										<Text size="sm" c="red">
											Unknown schema key in cfg layout: {schemaKey}
										</Text>
									</Paper>
								)
							}

							return (
								<Fragment key={chunk.key}>
									<ConfigTabContent
										pluginName={pluginName}
										tabKey={schemaKey}
										schema={schema}
										savedValue={toRecord(finalSavedConfig?.[schemaKey])}
										defaultValue={toRecord(defaults?.[schemaKey])}
										onSaved={(_k, value) =>
											setSavedOverride((prev) => ({
												...((prev ?? finalSavedConfig) as any),
												[schemaKey]: value,
											}))
										}
										showToc={false}
										active={active}
									/>
								</Fragment>
							)
						})}
					</TypographyStylesProvider>
				</Box>
			) : null}

			{rendered.remaining.length ? (
				<Paper withBorder radius="md" p="sm" mt="sm">
					<Stack gap={6}>
						<Text size="sm" fw={600}>
							Unplaced Schemas
						</Text>
						<Text size="sm" c="dimmed">
							cfg layout did not place some schema keys. They are appended here so config remains editable.
						</Text>
						{rendered.remaining.map((schemaKey) => {
							const schema = schemas?.[schemaKey]
							if (!schema) return null
							return (
								<Box key={`remaining-${schemaKey}`} mt="sm">
									<Text size="sm" fw={600} mb={6}>
										{schemaKey}
									</Text>
									<ConfigTabContent
										pluginName={pluginName}
										tabKey={schemaKey}
										schema={schema}
										savedValue={toRecord(finalSavedConfig?.[schemaKey])}
										defaultValue={toRecord(defaults?.[schemaKey])}
										onSaved={(_k, value) =>
											setSavedOverride((prev) => ({
												...((prev ?? finalSavedConfig) as any),
												[schemaKey]: value,
											}))
										}
										showToc={false}
										active={active}
									/>
								</Box>
							)
						})}
					</Stack>
				</Paper>
			) : null}
		</Box>
	)
}
