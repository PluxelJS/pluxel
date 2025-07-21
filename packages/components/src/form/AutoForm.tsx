import { useMemo } from 'react'
import { Group, Stack, Button, Card } from '@mantine/core'
import { type InferOutput, type ObjectSchema, getDefaults } from 'valibot'
import { MetaRenderer, extractInfo } from 'valibot-form'
import { useAppForm } from './formContext'
import { DebugValues } from './DebugValues'

interface AutoFormProps<S extends ObjectSchema<any, any>> {
	schema: S
	onSubmit: (values: InferOutput<S>) => void
}

export function AutoForm<S extends ObjectSchema<any, any>>({
	schema,
	onSubmit,
}: AutoFormProps<S>) {
	// 1. 初始化表单，默认值来自 schema
	const form = useAppForm({
		defaultValues: getDefaults(schema),
		// 2. 把同一个 schema 用于 onChange 和 onSubmit 验证
		validators: {
			onChange: schema as any,
		},
		onSubmit: ({ value }) => {
			onSubmit(value)
		},
	})

	// 缓存 schema.fields
	const entries = useMemo(
		() => Object.entries(schema.entries) as [keyof InferOutput<S>, any][],
		[schema],
	)

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				form.handleSubmit()
			}}
		>
			<Card shadow="sm" p="lg" radius="md" maw={600} mx="auto">
				<Stack>
					{entries.map(([key, subSchema]) => {
						if (subSchema.kind !== 'schema') return null
						const name = String(key)
						const info = extractInfo(subSchema, { title: name })
						if (!info) return null
						// const { props: options, formInfo, type } = info

						return (
							<form.Field key={name} name={name}>
								{(field) => (
									<MetaRenderer
										type={info.type}
										formBaseInfo={info.formInfo}
										extractedPropsInfo={info.props}
										error={field.state.meta.errors
											.map(({ message }) => message)
											.join(', ')}
										value={field.state.value as any}
										inputProps={{
											name,
											onChange: field.handleChange,
											onBlur: field.handleBlur,
										}}
									/>
								)}
							</form.Field>
						)
					})}
				</Stack>

				<Group gap="right" mt="md">
					<Button variant="outline" onClick={() => form.reset()}>
						取消
					</Button>
					<form.Subscribe selector={(s) => s.isValid}>
						{(isValid) => (
							<Button type="submit" disabled={!isValid}>
								提交
							</Button>
						)}
					</form.Subscribe>
				</Group>

				<form.Subscribe selector={(s) => s.values}>
					{(values) => <DebugValues formValues={values} />}
				</form.Subscribe>
			</Card>
		</form>
	)
}
