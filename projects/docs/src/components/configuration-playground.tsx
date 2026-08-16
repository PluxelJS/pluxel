'use client'

import '@mantine/core/styles.css'
import {
	Accordion,
	Alert,
	Button,
	Card,
	Code,
	Group,
	MantineProvider,
	Stack,
	Text,
	Title,
} from '@mantine/core'
import { init } from 'modern-monaco'
import type { editor } from 'modern-monaco/editor-core'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as v from 'valibot'
import * as f from 'valibot-form'
import type { ObjectLikeSchema } from 'valibot-form'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'
import { configurationSchema } from './configuration-schema'

const template = `const Config = v.object({
  enabled: v.optional(
    v.pipe(
      v.boolean(),
      f.formMeta({
        label: '启用插件',
        section: { id: 'runtime', title: '运行时' },
      }),
      f.booleanMeta({}),
    ),
    true,
  ),
  mode: v.optional(
    v.pipe(
      v.picklist(['development', 'production'] as const),
      f.formMeta({ label: '运行环境', section: 'runtime' }),
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
      f.formMeta({
        label: '上游地址',
        description: 'URL 约束来自 schema；表单只负责编辑。',
        section: { id: 'network', title: '网络与重试' },
      }),
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
      f.formMeta({ label: '监听端口', section: 'network' }),
      f.numberMeta({ min: 1, max: 65535, step: 1 }),
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
            f.formMeta({ label: '最大次数' }),
            f.numberMeta({ min: 1, max: 10, step: 1 }),
          ),
          3,
        ),
        backoffMs: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(100),
            f.formMeta({ label: '退避时间（毫秒）' }),
            f.numberMeta({ min: 100, step: 100 }),
          ),
          250,
        ),
      }),
      f.formMeta({ label: '重试策略', section: 'network' }),
      f.objectMeta({ variant: 'card', columns: 2 }),
    ),
    { attempts: 3, backoffMs: 250 },
  ),
  allowedOrigins: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.url())),
      f.formMeta({ label: '允许的 Origin', section: 'network' }),
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

return Config`

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
			types: [valibotUrl, valibotFormUrl, new URL('globals.d.ts', baseUrl).href],
		},
	}
}

function compileSchema(code: string): PlaygroundSchema {
	// The editor intentionally runs a user-authored schema in the page sandbox.
	const result: unknown = new Function('v', 'f', `"use strict";\n${code}`)(v, f)
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
								<Text size="sm" fw={600} mb={6}>
									提交给 Valibot 前的字段值
								</Text>
								<JsonValue value={input} />
							</Accordion.Panel>
						</Accordion.Item>
						<Accordion.Item value="output">
							<Accordion.Control>Output · Valibot 归一化结果</Accordion.Control>
							<Accordion.Panel>
								<Text size="sm" fw={600} mb={6}>
									默认值、校验与 transform 后的结果
								</Text>
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
	const codeRef = useRef(template)
	const [schema, setSchema] = useState<PlaygroundSchema>(() => configurationSchema)
	const [error, setError] = useState<string>()
	const [status, setStatus] = useState('使用当前 schema 生成表单。')
	const [revision, setRevision] = useState(0)
	const editorTheme = resolvedTheme === 'dark' ? 'vitesse-dark' : 'vitesse-light'

	useEffect(() => {
		let disposed = false
		let model: editor.ITextModel | undefined

		async function mountEditor() {
			if (!editorContainerRef.current) return

			globalThis.MonacoEnvironment ??= {}
			Object.assign(globalThis.MonacoEnvironment, { useBuiltinLSP: true })

			const monaco = await init({
				defaultTheme: editorTheme,
				langs: ['typescript'],
				lsp: {
					typescript: getTypeScriptLspOptions(),
				},
			})
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

	const setEditorCode = useCallback((nextCode: string) => {
		codeRef.current = nextCode
		const editorInstance = editorRef.current
		if (editorInstance && editorInstance.getValue() !== nextCode) {
			editorInstance.setValue(nextCode)
		}
	}, [])

	const run = useCallback(() => {
		try {
			setSchema(compileSchema(codeRef.current))
			setRevision((value) => value + 1)
			setError(undefined)
			setStatus('Schema 已运行，表单与结果已更新。')
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Schema 执行失败')
		}
	}, [])

	const formOptions = useMemo(() => {
		const defaults: unknown = v.getDefaults(schema)
		return { defaultValues: isRecord(defaults) ? defaults : {} }
	}, [schema])

	return (
		<MantineProvider>
			<Card id="configuration-playground" withBorder radius="md" p="lg">
				<Stack gap="lg">
					<div>
						<Title order={2} size="h3">
							配置 Playground
						</Title>
						<Text size="sm" c="dimmed" mt={4}>
							编辑器直接加载当前 workspace 的 Valibot 与 valibot-form 声明。输入 <Code>v.</Code> 或{' '}
							<Code>f.</Code> 可查看补全和类型；运行后表单、Input 与 Output 同步更新。
						</Text>
					</div>

					<div className="configuration-playground-layout">
						<Stack gap="md">
							<div>
								<Title order={3} size="h4">
									Schema 编辑器
								</Title>
								<Text size="sm" c="dimmed" mt={4}>
									修改代码后运行，结果区域会使用新的 schema。
								</Text>
							</div>

							<div className="overflow-hidden rounded-lg border">
								<div ref={editorContainerRef} className="configuration-playground-editor" />
							</div>

							<Group justify="space-between" align="center">
								<Text size="xs" c="dimmed">
									代码只在当前浏览器页面执行，不会保存或发送到服务端。
								</Text>
								<Group gap="xs">
									<Button
										variant="default"
										onClick={() => {
											setEditorCode(template)
											setSchema(configurationSchema)
											setRevision((value) => value + 1)
											setError(undefined)
											setStatus('已恢复示例 schema。')
										}}
									>
										重置
									</Button>
									<Button onClick={run}>运行 schema</Button>
								</Group>
							</Group>

							{error ? <Alert color="red">{error}</Alert> : null}
							<Text size="xs" c="dimmed" aria-live="polite">
								{status}
							</Text>
						</Stack>

						<Stack gap="md">
							<div>
								<Title order={3} size="h4">
									表单与结果
								</Title>
								<Text size="sm" c="dimmed" mt={4}>
									表单由 schema 和 valibot-form metadata 共同生成；各区域可独立折叠。
								</Text>
							</div>

							<AutoForm schema={schema} formOpts={formOptions} resetKey={revision}>
								<Accordion multiple defaultValue={['form', 'output']} variant="contained" order={4}>
									<Accordion.Item value="form">
										<Accordion.Control>生成的表单</Accordion.Control>
										<Accordion.Panel>
											<Stack gap="md">
												<AutoForm.Fields />
												<AutoForm.Actions>
													{({ reset, dirty }) => (
														<Group justify="flex-end">
															<Button variant="default" disabled={!dirty} onClick={() => reset()}>
																恢复默认值
															</Button>
														</Group>
													)}
												</AutoForm.Actions>
											</Stack>
										</Accordion.Panel>
									</Accordion.Item>
									<ValueInspector schema={schema} />
								</Accordion>
							</AutoForm>
						</Stack>
					</div>
				</Stack>
			</Card>
		</MantineProvider>
	)
}
