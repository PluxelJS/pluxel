// src/components/AutoForm.tsx
import { useMemo } from 'react'
import { Group, Stack, Button, Card } from '@mantine/core'
import type { InferOutput, ObjectSchema } from 'valibot'
import { MetaRenderer, extractInfo } from 'valibot-form'
import { useAppForm } from './formContext'
import { DebugValues } from './DebugValues'
import type { formOptions } from '@tanstack/react-form'

export interface AutoFormProps<S extends ObjectSchema<any, any>> {
	schema: S
	formOpts?: ReturnType<typeof formOptions>
}

export function AutoForm<S extends ObjectSchema<any, any>>({
	schema,
	formOpts,
}: AutoFormProps<S>) {
	// 1. 初始化表单，内部已处理 SSR 合并和默认值
	const form = useAppForm(schema, formOpts)

	// 2. 缓存 schema.entries 遍历
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
					<form.Subscribe
						selector={(formState) => [
							formState.canSubmit,
							formState.isSubmitting,
						]}
					>
						{([canSubmit, isSubmitting]) => (
							<Button type="submit" disabled={!canSubmit}>
								{isSubmitting ? '...' : 'Submit'}
							</Button>
						)}
					</form.Subscribe>
				</Group>

				<form.Subscribe selector={(s) => [s.values, s.errorMap, s.errors]}>
					{([values, errorMap, errors]) => (
						<DebugValues formValues={{ values, errorMap, errors }} />
					)}
				</form.Subscribe>
			</Card>
		</form>
	)
}
