import './renders'
import { Button, Card, Group, Stack } from '@mantine/core'
import {
	type SubmitHandler,
	getValues,
	reset,
	useForm,
	valiForm,
} from '@modular-forms/react'
import { useSignalEffect } from '@preact/signals-react'
import { useMemo, useState } from 'react'
import { type InferOutput, type ObjectSchema, getDefaults } from 'valibot'
import { MetaRenderer, type Schema, extractInfo } from 'valibot-form'
import { DebugValues } from './DebugValues'

interface AutoFormProps<S extends ObjectSchema<any, any>> {
	schema: S
	onSubmit: SubmitHandler<InferOutput<S>>
}

export function AutoForm<S extends ObjectSchema<any, any>>({
	schema,
	onSubmit,
}: AutoFormProps<S>) {
	// 1. 初始化 modular-forms
	const [form, { Form, Field }] = useForm<any>({
		initialValues: getDefaults(schema),
		validate: valiForm(schema),
		validateOn: 'change',
		revalidateOn: 'change',
	})

	const [, forceUpdate] = useState({})
	useSignalEffect(() => {
		// 每次读取 getValues 就会订阅内部信号
		getValues(form)
		forceUpdate({})
	})

	// 2. 缓存 schema.entries
	const entries = useMemo(
		() => Object.entries(schema.entries) as [keyof InferOutput<S>, any][],
		[schema],
	)

	return (
		<Card shadow="sm" p="lg" radius="md" maw={600} mx="auto">
			{/* 3. 表单主体 */}
			<Form onSubmit={onSubmit}>
				<Stack>
					{entries.map(([key, subSchema]) => {
						if (subSchema.kind !== 'schema') return null
						const name = String(key)
						const info = extractInfo(subSchema, { title: name })
						if (!info) return null
						const { props: options, formInfo, type } = info

						return (
							<Field key={name} name={name}>
								{(field, inputProps) => (
									<MetaRenderer
										inputProps={inputProps}
										type={type}
										options={options}
										error={field.error.value}
										formInfo={formInfo}
										value={field.value as any}
									/>
								)}
							</Field>
						)
					})}
				</Stack>

				{/* 4. 操作按钮区 */}
				<Group>
					<Button variant="outline" onClick={() => reset(form)}>
						取消
					</Button>
					<Button type="submit" disabled={form.invalid.value}>
						提交
					</Button>
				</Group>
			</Form>
			<DebugValues form={form} />
		</Card>
	)
}
