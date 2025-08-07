// src/components/ConfigForm.tsx
import React, { useMemo } from 'react'
import {
	Title,
	Text,
	Group,
	Badge,
	Box,
	Anchor,
	Tabs,
	Divider,
} from '@mantine/core'
import { useMutation } from '@tanstack/react-query'
import { client } from '../rpc'
import type { ObjectSchema, InferOutput } from 'valibot'
import { getDefaults } from 'valibot'
import { AutoForm } from '@pluxel/components'
import type { InferRequestType, InferResponseType } from 'hono/client'
import { formOptions } from '@tanstack/react-form'
import { notifications } from '@mantine/notifications'

export interface ConfigFormProps {
	pluginName: string
	configs: Record<string, ObjectSchema<any, any>>
	existConfigs?: any
}

export function ConfigForm({
	pluginName,
	configs,
	existConfigs,
}: ConfigFormProps) {
	const $post = client.plugins[':name'].$post
	type Payload = InferRequestType<typeof $post>['json'] & {
		signal?: AbortSignal
	}
	type Response = InferResponseType<typeof $post>
	const mutation = useMutation<Response, Error, Payload>({
		mutationFn: async (body) => {
			const res = await $post(
				{ param: { name: pluginName }, json: body },
				{ init: { signal: body.signal } },
			)
			return res.json()
		},
	})

	const keys = useMemo(() => Object.keys(configs), [configs])
	const defaultTab = keys[0] || ''

	return (
		<Box>
			<Group align="apart" mb="md">
				<Title order={3}>{pluginName} 配置</Title>
				<Anchor href={`/plugins/${pluginName}/docs`} target="_blank">
					查看文档
				</Anchor>
			</Group>

			<Tabs defaultValue={defaultTab} variant="outline">
				<Tabs.List>
					{keys.map((key) => (
						<Tabs.Tab key={key} value={key}>
							{key}
						</Tabs.Tab>
					))}
				</Tabs.List>

				<Box>
					{keys.map((key, idx) => {
						const schema = configs[key]!
						const existConfig = existConfigs?.[key] ?? {}
						type Values = InferOutput<typeof schema>
						const opts = useMemo(
							() =>
								formOptions<Values>({
									defaultValues: Object.assign(
										getDefaults(schema),
										existConfig,
									) as Values,
									asyncAlways: true,
									asyncDebounceMs: 200,
									validators: {
										onChangeAsync: async ({
											value,
											signal,
										}: { value: any; signal: any }) => {
											const result = await mutation.mutateAsync({
												isSubmitAction: false,
												formData: { [key]: value },
												signal,
											})
											if (result.code === 'validation_error') {
												return { fields: result.errors[key] }
											}
										},
									},
									onSubmit: async ({
										value,
										signal,
									}: { value: any; signal: any }) => {
										const result = await mutation.mutateAsync({
											isSubmitAction: true,
											formData: { [key]: value },
											signal,
										})
										if (result.code !== 'success') {
											notifications.show({
												title: '提交失败',
												message: result.code,
												color: 'red',
											})
										} else {
											notifications.show({
												title: '提交成功',
												message: `配置 ${key} 已提交到服务器。`,
											})
										}
									},
								}),
							[existConfig, schema, key],
						)

						return (
							<Tabs.Panel key={key} value={key} pt="md">
								<Box style={{ flex: 1, overflow: 'auto', padding: '0 16px' }}>
									<Group align="apart" mb="sm">
										<Text size="lg">{key}</Text>
										<Badge color="blue">必填</Badge>
									</Group>

									<AutoForm schema={schema} formOpts={opts} />

									{mutation.isError && (
										<Text color="red" mt="sm">
											{mutation.error?.message}
										</Text>
									)}

									{idx < keys.length - 1 && <Divider my="xl" />}
								</Box>
							</Tabs.Panel>
						)
					})}
				</Box>
			</Tabs>
		</Box>
	)
}
