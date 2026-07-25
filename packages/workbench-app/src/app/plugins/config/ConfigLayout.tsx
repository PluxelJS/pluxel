import { Box, Paper, Stack, Text, Typography } from '@mantine/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { MarkdownExit } from 'markdown-exit'
import { type ConfigFormState, ConfigTabContent } from './ConfigTab'
import { compareSchemaKeys } from './schemaKey'
import type { WorkbenchMarkdownPart as BuiltinMarkdownPart } from '@pluxel/runtime/workbench'

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i += 1) {
			if (!deepEqual(a[i], b[i])) return false
		}
		return true
	}
	if (isRecord(a) && isRecord(b)) {
		const aKeys = Object.keys(a)
		const bKeys = Object.keys(b)
		if (aKeys.length !== bKeys.length) return false
		for (const key of aKeys) {
			if (!(key in b)) return false
			if (!deepEqual(a[key], b[key])) return false
		}
		return true
	}
	return false
}

export function ConfigLayout({
	pluginName,
	layout,
	schemas,
	savedConfig,
	defaults,
	active,
	activeKey,
	draftValues,
	onDirtyChange,
	onDraftChange,
}: {
	pluginName: string
	layout: BuiltinMarkdownPart[]
	schemas: Record<string, ObjectSchema<any, any>>
	savedConfig: Record<string, unknown>
	defaults: Record<string, unknown>
	active: boolean
	activeKey?: string
	draftValues?: Record<string, Record<string, unknown>>
	onDirtyChange?: (dirty: boolean) => void
	onDraftChange?: (drafts: Record<string, Record<string, unknown>>) => void
}) {
	const [formStates, setFormStates] = useState<Record<string, ConfigFormState>>({})
	const lastDraftsRef = useRef<Record<string, Record<string, unknown>>>({})
	const schemaNodeRefs = useRef<Record<string, HTMLDivElement | null>>({})

	useEffect(() => {
		onDirtyChange?.(Object.values(formStates).some((state) => state?.dirty))
	}, [formStates, onDirtyChange])

	useEffect(() => {
		const nextDrafts: Record<string, Record<string, unknown>> = {}
		for (const [key, state] of Object.entries(formStates)) {
			if (!state?.dirty) continue
			nextDrafts[key] = toRecord(state.values)
		}
		if (!onDraftChange) return undefined
		if (deepEqual(lastDraftsRef.current, nextDrafts)) return undefined
		const handle = window.setTimeout(() => {
			lastDraftsRef.current = nextDrafts
			onDraftChange(nextDrafts)
		}, 120)
		return () => window.clearTimeout(handle)
	}, [formStates, onDraftChange])

	const schemaKeys = useMemo(() => Object.keys(schemas ?? {}).sort(compareSchemaKeys), [schemas])
	const resolvedActiveKey =
		activeKey && schemaKeys.includes(activeKey) ? activeKey : (schemaKeys[0] ?? '')

	const rendered = useMemo(() => {
		const used = new Set<string>()
		const chunks: Array<
			{ kind: 'md'; key: string; html: string } | { kind: 'schema'; key: string; schemaKey: string }
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

	useEffect(() => {
		if (!active || !resolvedActiveKey) return undefined
		const handle = window.requestAnimationFrame(() => {
			const node = schemaNodeRefs.current[resolvedActiveKey]
			if (typeof node?.scrollIntoView !== 'function') return
			node.scrollIntoView({
				block: 'start',
				inline: 'nearest',
			})
		})
		return () => window.cancelAnimationFrame(handle)
	}, [active, rendered.chunks, rendered.remaining, resolvedActiveKey])

	const reportState = useCallback((key: string, state: ConfigFormState) => {
		setFormStates((prev) => {
			const existing = prev[key]
			if (
				existing &&
				existing.dirty === state.dirty &&
				existing.canSubmit === state.canSubmit &&
				existing.submitting === state.submitting &&
				deepEqual(existing.values, state.values)
			) {
				return prev
			}
			return { ...prev, [key]: state }
		})
	}, [])

	return (
		<Box style={{ flex: 1, minHeight: 0 }}>
			{rendered.chunks.length > 0 ? (
				<Box>
					<Typography>
						{rendered.chunks.map((chunk) => {
							if (chunk.kind === 'md') {
								// oxlint-disable-next-line react/no-danger -- markdown is plugin-authored source code.
								return <Box key={chunk.key} dangerouslySetInnerHTML={{ __html: chunk.html }} />
							}
							const schemaKey = chunk.schemaKey
							const schema = schemas?.[schemaKey]
							if (!schema) {
								return (
									<Paper key={chunk.key} withBorder radius="sm" p="sm" my="sm">
										<Text size="sm" c="red">
											Unknown schema key in cfg layout: {schemaKey}
										</Text>
									</Paper>
								)
							}

							return (
								<Box
									key={chunk.key}
									ref={(node) => {
										schemaNodeRefs.current[schemaKey] = node
									}}
									data-config-schema={schemaKey}
								>
									<ConfigTabContent
										pluginName={pluginName}
										tabKey={schemaKey}
										schema={schema}
										savedValue={toRecord(savedConfig?.[schemaKey])}
										defaultValue={toRecord(defaults?.[schemaKey])}
										draftValue={toRecord(draftValues?.[schemaKey])}
										reportState={reportState}
										showToc={false}
										showActions
										active={active && resolvedActiveKey === schemaKey}
									/>
								</Box>
							)
						})}
					</Typography>
				</Box>
			) : null}

			{rendered.remaining.length > 0 ? (
				<Paper withBorder radius="sm" p="sm" mt="sm">
					<Stack gap={6}>
						<Text size="sm" fw={600}>
							Unplaced Schemas
						</Text>
						<Text size="sm" c="dimmed">
							cfg layout did not place some schema keys. They are appended here so config remains
							editable.
						</Text>
						{rendered.remaining.map((schemaKey) => {
							const schema = schemas?.[schemaKey]
							if (!schema) return null
							return (
								<Box
									key={`remaining-${schemaKey}`}
									ref={(node) => {
										schemaNodeRefs.current[schemaKey] = node
									}}
									data-config-schema={schemaKey}
									mt="sm"
								>
									<Text size="sm" fw={600} mb={6}>
										{schemaKey}
									</Text>
									<ConfigTabContent
										pluginName={pluginName}
										tabKey={schemaKey}
										schema={schema}
										savedValue={toRecord(savedConfig?.[schemaKey])}
										defaultValue={toRecord(defaults?.[schemaKey])}
										draftValue={toRecord(draftValues?.[schemaKey])}
										reportState={reportState}
										showToc={false}
										showActions
										active={active && resolvedActiveKey === schemaKey}
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
