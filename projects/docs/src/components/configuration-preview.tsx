'use client'

import '@mantine/core/styles.css'
import { Accordion, Button, Card, Code, Group, Stack, Text, Title } from '@mantine/core'
import { useMemo } from 'react'
import * as v from 'valibot'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'
import { configurationSchema } from './configuration-schema'
import { MantineThemeProvider } from './mantine-theme-provider'

function JsonValue({ value }: { value: unknown }) {
	return (
		<Code block style={{ maxHeight: '18rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
			{JSON.stringify(value, null, 2)}
		</Code>
	)
}

function ValueInspector() {
	const { form } = useAutoFormCtx<any>()

	return (
		<form.Subscribe selector={(state) => state.values}>
			{(input) => {
				const result = v.safeParse(configurationSchema, input)
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

export function ConfigurationPreview() {
	const formOptions = useMemo(() => {
		const defaults = v.getDefaults(configurationSchema)
		return {
			defaultValues: {
				...defaults,
				allowedOrigins: [...defaults.allowedOrigins],
			},
		}
	}, [])

	return (
		<MantineThemeProvider>
			<Card id="configuration-preview" radius="md" p="md">
				<Stack gap="lg">
					<div>
						<Title order={3}>表单渲染</Title>
						<Text size="sm" c="dimmed" mt={4}>
							修改字段观察控件、原始 Input 和 Valibot Output 如何由同一份 schema 派生。
						</Text>
					</div>

					<AutoForm schema={configurationSchema} formOpts={formOptions}>
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
							<ValueInspector />
						</Accordion>
					</AutoForm>
				</Stack>
			</Card>
		</MantineThemeProvider>
	)
}
