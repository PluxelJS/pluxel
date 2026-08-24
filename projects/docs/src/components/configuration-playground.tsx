'use client'

import '@mantine/core/styles.css'
import { Accordion, Alert, Button, Code, Group, Select, Stack, Text, Title } from '@mantine/core'
import { init } from 'modern-monaco'
import { registerLSPProvider } from 'modern-monaco/core'
import type { editor } from 'modern-monaco/editor-core'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as v from 'valibot'
import * as f from 'valibot-form'
import type { ObjectLikeSchema } from 'valibot-form'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'
import { configurationSchema } from './configuration-schema'
import { MantineThemeProvider } from './mantine-theme-provider'

registerLSPProvider('typescript', {
	aliases: ['javascript', 'jsx', 'tsx'],
	import: () => import('modern-monaco/lsp/typescript/setup'),
})

let monacoPromise: ReturnType<typeof init> | undefined

function initPlaygroundMonaco(defaultTheme: string) {
	globalThis.MonacoEnvironment ??= {}
	Object.assign(globalThis.MonacoEnvironment, { useBuiltinLSP: false })

	monacoPromise ??= init({
		defaultTheme,
		langs: ['typescript'],
		lsp: {
			typescript: getTypeScriptLspOptions(),
		},
	})
	return monacoPromise
}

const serviceTemplate = `import * as v from 'valibot'
import * as f from 'valibot-form'

const Config = v.object({
  enabled: v.optional(
    v.pipe(
      v.boolean(),
      f.formMeta({ title: '启用插件', section: { id: 'runtime', title: '运行时' } }),
    ),
    true,
  ),
  mode: v.optional(
    v.pipe(
      v.picklist(['development', 'production'] as const),
      f.formMeta({ title: '运行环境', section: 'runtime' }),
      f.picklistMeta({
        control: 'segmented',
        labels: { development: '开发', production: '生产' },
      }),
    ),
    'development',
  ),
  endpoint: v.optional(
    v.pipe(
      v.string(),
      v.url(),
      f.formMeta({ title: '上游地址', description: 'URL 约束来自 schema；表单只负责编辑。', section: { id: 'network', title: '网络与重试' } }),
      f.stringMeta({ placeholder: 'https://api.example.com' }),
    ),
    'https://api.example.com',
  ),
  port: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(65535),
      f.formMeta({ title: '监听端口', section: 'network' }),
      f.numberMeta({ step: 1 }),
    ),
    8787,
  ),
  retry: v.optional(
    v.pipe(
      v.object({
        attempts: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(10),
            f.formMeta({ title: '最大次数' }),
            f.numberMeta({ step: 1 }),
          ),
          3,
        ),
        backoffMs: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(100),
            f.formMeta({ title: '退避时间（毫秒）' }),
            f.numberMeta({ step: 100 }),
          ),
          250,
        ),
      }),
      f.formMeta({ title: '重试策略', section: 'network' }),
      f.objectMeta({ variant: 'card', columns: 2 }),
    ),
    { attempts: 3, backoffMs: 250 },
  ),
  allowedOrigins: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.url())),
      f.formMeta({ title: '允许的 Origin', section: 'network' }),
      f.arrayMeta({
        layout: 'list',
        itemLabel: 'Origin',
        addLabel: '添加 Origin',
        defaultItem: 'https://api.example.com',
      }),
    ),
    ['https://api.example.com'],
  ),
})

export default Config`

const cacheTemplate = `import * as v from 'valibot'
import * as f from 'valibot-form'

const Config = v.object({
  backend: v.optional(
    v.pipe(
      v.picklist(['memory', 'redis'] as const),
      f.formMeta({ title: '缓存后端' }),
      f.picklistMeta({
        control: 'segmented',
        labels: { memory: '内存', redis: 'Redis' },
      }),
    ),
    'memory',
  ),
  namespace: v.optional(
    v.pipe(
      v.string(),
      f.formMeta({ title: '命名空间' }),
      f.stringMeta({ placeholder: 'pluxel' }),
    ),
    'pluxel',
  ),
  ttl: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      f.formMeta({ title: 'TTL（秒）' }),
      f.numberMeta({ step: 60 }),
    ),
    3600,
  ),
})

export default Config`

const releaseTemplate = `import * as v from 'valibot'
import * as f from 'valibot-form'

const Config = v.object({
  channel: v.optional(
    v.pipe(
      v.picklist(['canary', 'stable'] as const),
      f.formMeta({ title: '发布通道' }),
      f.picklistMeta({
        control: 'segmented',
        labels: { canary: 'Canary', stable: 'Stable' },
      }),
    ),
    'canary',
  ),
  dryRun: v.optional(
    v.pipe(
      v.boolean(),
      f.formMeta({ title: '仅生成计划' }),
    ),
    true,
  ),
  targets: v.optional(
    v.pipe(
      v.array(v.string()),
      f.formMeta({ title: '目标环境' }),
      f.arrayMeta({
        layout: 'list',
        itemLabel: '环境',
        addLabel: '添加环境',
        defaultItem: 'staging',
      }),
    ),
    ['staging'],
  ),
})

export default Config`

const presets = {
	service: { label: '服务运行时', code: serviceTemplate },
	cache: { label: '缓存插件', code: cacheTemplate },
	release: { label: '发布流程', code: releaseTemplate },
} as const

type PresetId = keyof typeof presets
type PlaygroundSelection = PresetId | 'custom'

const playgroundStorageKey = 'pluxel.configuration-playground.v1'

interface StoredPlayground {
	code: string
	lastRunCode: string
	preset: PlaygroundSelection
}

function isPresetId(value: string): value is PresetId {
	return value in presets
}

function isStoredPlayground(value: unknown): value is StoredPlayground {
	return (
		isRecord(value) &&
		typeof value.code === 'string' &&
		typeof value.lastRunCode === 'string' &&
		(value.preset === 'custom' || (typeof value.preset === 'string' && isPresetId(value.preset)))
	)
}

function savePlayground(value: StoredPlayground) {
	localStorage.setItem(playgroundStorageKey, JSON.stringify(value))
}

type PlaygroundSchema = ObjectLikeSchema

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

function isPlaygroundSchema(value: unknown): value is PlaygroundSchema {
	return isRecord(value) && (value.type === 'object' || value.type === 'intersect')
}

function getTypeScriptLspOptions() {
	const baseUrl = new URL('/playground-types/', window.location.origin)
	const valibotUrl = new URL('valibot.d.ts', baseUrl).href
	const valibotFormUrl = new URL('valibot-form.d.ts', baseUrl).href

	return {
		importMap: {
			imports: {
				valibot: valibotUrl,
				'valibot-form': valibotFormUrl,
			},
			scopes: {},
		},
		compilerOptions: {
			strict: true,
			types: [valibotUrl, valibotFormUrl],
		},
	}
}

function compileSchema(code: string): PlaygroundSchema {
	const executableCode = code
		.replace(/^\s*import \* as v from ['"]valibot['"];?\s*$/m, '')
		.replace(/^\s*import \* as f from ['"]valibot-form['"];?\s*$/m, '')
		.replaceAll(' as const', '')
		.replace(/\bexport default Config\s*$/, 'return Config')
	// 编辑器有意在页面沙箱中执行用户编写的 schema。
	const result: unknown = new Function('v', 'f', `"use strict";\n${executableCode}`)(v, f)
	if (!isPlaygroundSchema(result)) {
		throw new Error('Playground 只接受 object 或 intersect schema')
	}
	return result
}

function JsonValue({ value }: { value: unknown }) {
	return (
		<Code block style={{ maxHeight: '18rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
			{JSON.stringify(value, null, 2)}
		</Code>
	)
}

function ValueInspector({ schema }: { schema: PlaygroundSchema }) {
	const { form } = useAutoFormCtx<any>()

	return (
		<form.Subscribe selector={(state) => state.values}>
			{(input) => {
				const result = v.safeParse(schema, input)
				return (
					<>
						<Accordion.Item value="input">
							<Accordion.Control>Input · 表单原始值</Accordion.Control>
							<Accordion.Panel>
								<JsonValue value={input} />
							</Accordion.Panel>
						</Accordion.Item>
						<Accordion.Item value="output">
							<Accordion.Control>Output · Valibot 归一化结果</Accordion.Control>
							<Accordion.Panel>
								<JsonValue value={result.success ? result.output : { issues: result.issues }} />
							</Accordion.Panel>
						</Accordion.Item>
					</>
				)
			}}
		</form.Subscribe>
	)
}

export function ConfigurationPlayground() {
	const { resolvedTheme } = useTheme()
	const editorContainerRef = useRef<HTMLDivElement>(null)
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
	const codeRef = useRef(serviceTemplate)
	const lastRunCodeRef = useRef(serviceTemplate)
	const selectionRef = useRef<PlaygroundSelection>('service')
	const [schema, setSchema] = useState<PlaygroundSchema>(() => configurationSchema)
	const [error, setError] = useState<string>()
	const [status, setStatus] = useState('使用当前 schema 生成表单。')
	const [revision, setRevision] = useState(0)
	const [selection, setSelection] = useState<PlaygroundSelection>('service')
	const [dirty, setDirty] = useState(false)
	const editorTheme = resolvedTheme === 'dark' ? 'vitesse-dark' : 'vitesse-light'

	useEffect(() => {
		let disposed = false
		let model: editor.ITextModel | undefined

		async function mountEditor() {
			if (!editorContainerRef.current) return

			try {
				const stored: unknown = JSON.parse(localStorage.getItem(playgroundStorageKey) ?? 'null')
				if (isStoredPlayground(stored)) {
					const restoredSchema = compileSchema(stored.lastRunCode)
					codeRef.current = stored.code
					lastRunCodeRef.current = stored.lastRunCode
					const storedSelection =
						stored.preset === 'custom' ||
						(typeof stored.preset === 'string' && isPresetId(stored.preset))
							? stored.preset
							: 'custom'
					selectionRef.current = storedSelection
					setSelection(storedSelection)
					setDirty(stored.code !== stored.lastRunCode)
					setSchema(restoredSchema)
					setRevision((value) => value + 1)
					setStatus('已恢复上次编辑。')
				}
			} catch {
				localStorage.removeItem(playgroundStorageKey)
			}

			const monaco = await initPlaygroundMonaco(editorTheme)
			if (disposed || !editorContainerRef.current) return

			model = monaco.editor.createModel(
				codeRef.current,
				'typescript',
				monaco.Uri.parse('file:///configuration-playground.ts'),
			)
			const editorInstance = monaco.editor.create(editorContainerRef.current, {
				ariaLabel: 'Valibot 配置 Schema 编辑器',
				automaticLayout: true,
				fontSize: 14,
				minimap: { enabled: false },
				padding: { top: 14 },
				scrollBeyondLastLine: false,
				tabSize: 2,
				theme: editorTheme,
			})
			editorInstance.setModel(model)
			editorRef.current = editorInstance
			editorInstance.onDidChangeModelContent(() => {
				codeRef.current = editorInstance.getValue()
				const nextSelection =
					selectionRef.current !== 'custom' &&
					presets[selectionRef.current].code === codeRef.current
						? selectionRef.current
						: 'custom'
				selectionRef.current = nextSelection
				setSelection(nextSelection)
				setDirty(codeRef.current !== lastRunCodeRef.current)
				savePlayground({
					code: codeRef.current,
					lastRunCode: lastRunCodeRef.current,
					preset: nextSelection,
				})
			})
		}

		void mountEditor().catch((cause) => {
			if (!disposed) setError(cause instanceof Error ? cause.message : '编辑器加载失败')
		})

		return () => {
			disposed = true
			editorRef.current?.dispose()
			editorRef.current = null
			model?.dispose()
		}
	}, [])

	useEffect(() => {
		editorRef.current?.updateOptions({ theme: editorTheme })
	}, [editorTheme])

	const setEditorCode = useCallback((nextCode: string, nextSelection: PlaygroundSelection) => {
		codeRef.current = nextCode
		selectionRef.current = nextSelection
		setSelection(nextSelection)
		setDirty(nextCode !== lastRunCodeRef.current)
		savePlayground({
			code: nextCode,
			lastRunCode: lastRunCodeRef.current,
			preset: nextSelection,
		})
		const editorInstance = editorRef.current
		if (editorInstance && editorInstance.getValue() !== nextCode) {
			editorInstance.setValue(nextCode)
		}
	}, [])

	const run = useCallback(() => {
		try {
			setSchema(compileSchema(codeRef.current))
			lastRunCodeRef.current = codeRef.current
			setRevision((value) => value + 1)
			setError(undefined)
			setDirty(false)
			setStatus('Schema 已运行，表单与结果已更新。')
			savePlayground({
				code: codeRef.current,
				lastRunCode: codeRef.current,
				preset: selectionRef.current,
			})
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Schema 执行失败')
		}
	}, [])

	const formOptions = useMemo(() => {
		const defaults: unknown = v.getDefaults(schema)
		return { defaultValues: isRecord(defaults) ? defaults : {} }
	}, [schema])

	return (
		<MantineThemeProvider>
			<div id="configuration-playground" className="configuration-playground-shell">
				<Title order={1} size="h2">
					配置 Playground
				</Title>

				<AutoForm schema={schema} formOpts={formOptions} resetKey={revision}>
					<div className="configuration-playground-layout">
						<Stack
							className="configuration-playground-pane configuration-playground-editor-pane"
							gap="md"
						>
							<div>
								<Title order={3} size="h4">
									Schema
								</Title>
							</div>

							<div className="configuration-playground-editor-frame overflow-hidden rounded-lg border">
								<div ref={editorContainerRef} className="configuration-playground-editor" />
							</div>

							<Group justify="space-between" align="center">
								<Text size="xs" c="dimmed">
									草稿仅保存在当前浏览器，不会发送到服务端。
								</Text>
								<Group gap="xs">
									<Select
										aria-label="Config 预设"
										data={[
											{ value: 'custom', label: '自定义', disabled: true },
											...Object.entries(presets).map(([value, preset]) => ({
												value,
												label: preset.label,
											})),
										]}
										value={selection}
										onChange={(value) => {
											if (value && isPresetId(value)) setEditorCode(presets[value].code, value)
										}}
										w={150}
									/>
									<Button
										variant="default"
										onClick={() => {
											const preset = selection === 'custom' ? 'service' : selection
											setEditorCode(presets[preset].code, preset)
											setError(undefined)
											setStatus(`已恢复「${presets[preset].label}」预设，运行后更新预览。`)
										}}
									>
										重置
									</Button>
									<Button disabled={!dirty} onClick={run}>
										运行 schema
									</Button>
								</Group>
							</Group>

							{error ? <Alert color="red">{error}</Alert> : null}
							<Text size="xs" c="dimmed" aria-live="polite">
								{status}
							</Text>

							<Accordion multiple variant="contained" order={4}>
								<ValueInspector schema={schema} />
							</Accordion>
						</Stack>

						<Stack
							className="configuration-playground-pane configuration-playground-preview-pane"
							gap="md"
						>
							<div>
								<Title order={3} size="h4">
									预览
								</Title>
							</div>

							<Accordion defaultValue="form" variant="contained" order={4}>
								<Accordion.Item value="form">
									<Accordion.Control>生成的表单</Accordion.Control>
									<Accordion.Panel>
										<Stack gap="md">
											<AutoForm.Fields />
											<AutoForm.Actions>
												{({ reset, dirty: formDirty }) => (
													<Group justify="flex-end">
														<Button variant="default" disabled={!formDirty} onClick={() => reset()}>
															恢复默认值
														</Button>
													</Group>
												)}
											</AutoForm.Actions>
										</Stack>
									</Accordion.Panel>
								</Accordion.Item>
							</Accordion>
						</Stack>
					</div>
				</AutoForm>
			</div>
		</MantineThemeProvider>
	)
}
