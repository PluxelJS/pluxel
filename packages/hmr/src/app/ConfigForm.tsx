// src/components/ConfigForm.tsx
import React from 'react'
import {
	Title,
	Text,
	Group,
	Badge,
	SimpleGrid,
	Box,
	Anchor,
	Divider,
	Button,
} from '@mantine/core'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '../rpc'
import type { ObjectSchema, InferOutput } from 'valibot'
import { getDefaults } from 'valibot'
import { AutoForm } from '@pluxel/components'
import type { InferRequestType, InferResponseType } from 'hono/client'
import { formOptions } from '@tanstack/react-form'

export interface ConfigFormProps {
	pluginName: string
	configs: Record<string, ObjectSchema<any, any>>
}

export function ConfigForm({ pluginName, configs }: ConfigFormProps) {
	const queryClient = useQueryClient()
	const $post = client.plugins[':name'].$post

	// 自动推断请求体 & 返回类型
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

			const data = await res.json()
			return data
			if (data.code === 'validation_error') {
				return data
			}
		},
		onSuccess: () => {
			// 提交成功后刷新插件详情
			queryClient.invalidateQueries(['plugins', pluginName])
		},
	})

	return (
		<Box>
			{/* 标题 + 文档链接 */}
			<Group align="apart" mb="md">
				<Title order={3}>{pluginName} 配置</Title>
				<Anchor href={`/plugins/${pluginName}/docs`} target="_blank">
					查看文档
				</Anchor>
			</Group>

			<SimpleGrid cols={2} spacing="lg">
				{Object.entries(configs).map(([key, schema], idx, arr) => {
					type Values = InferOutput<typeof schema>
					const opts = formOptions<Values>({
						defaultValues: getDefaults(schema) as Values,
						validators: {
							onChangeAsync: async ({
								value,
								signal,
								formApi,
							}: { value: any; signal: AbortSignal; formApi: any }) => {
								const payload: Payload = {
									isSubmitAction: true,
									formData: { [key]: value },
									signal,
								}
								const result = await mutation.mutateAsync(payload)
								if (result.code === 'validation_error') {
									return result.errors[key]
								}
								formApi.setErrorMap(null)
							},
						},
						onSubmit: () => {
							mutation.reset()
						},
					})

					return (
						<Box key={key} p="md">
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

							{idx < arr.length - 1 && <Divider my="xl" />}
						</Box>
					)
				})}
			</SimpleGrid>
		</Box>
	)
}
