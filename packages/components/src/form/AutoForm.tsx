// src/components/AutoForm.tsx
import React, { useMemo } from 'react'
import {
	Card,
	CardSection,
	ScrollArea,
	Stack,
	Group,
	Button,
	useMantineTheme,
} from '@mantine/core'
import type { InferOutput, ObjectSchema } from 'valibot'
import { MetaRenderer, extractInfo } from 'valibot-form'
import { useAppForm } from './formContext'
import { DebugValues } from './DebugValues'
import type { formOptions } from '@tanstack/react-form'

export interface AutoFormProps<S extends ObjectSchema<any, any>> {
	schema: S
	formOpts?: ReturnType<typeof formOptions>
	/** 字段区最大高度，超出滚动 */
	scrollMaxHeight?: number | string
	/** 是否显示 Debug 面板，默认开发环境打开 */
	showDebug?: boolean
}

export function AutoForm<S extends ObjectSchema<any, any>>({
	schema,
	formOpts,
	scrollMaxHeight = '60vh',
	showDebug,
}: AutoFormProps<S>) {
	const theme = useMantineTheme()
	const form = useAppForm(schema, formOpts)
	const entries = useMemo(
		() => Object.entries(schema.entries) as [keyof InferOutput<S>, any][],
		[schema],
	)
	const isDev = import.meta.env.DEV || process.env.NODE_ENV === 'development'
	const debug = showDebug ?? isDev

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault()
				form.handleSubmit()
			}}
		>
			<Card
				shadow="sm"
				radius="md"
				style={{
					width: '100%',
					height: '100%',
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				<CardSection style={{ flex: 1, overflow: 'hidden', padding: 0 }}>
					<ScrollArea.Autosize
						mah={scrollMaxHeight}
						offsetScrollbars
						style={{ width: '100%' }}
					>
						<Stack gap="md" style={{ padding: '24px' }}>
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
													.map((e) => e.message)
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
					</ScrollArea.Autosize>
				</CardSection>

				<form.Subscribe
					selector={(s) => [s.isDirty, s.canSubmit, s.isSubmitting] as const}
				>
					{([dirty, canSubmit, submitting]) =>
						dirty && (
							<CardSection withBorder>
								<Group align="right" gap="md">
									<Button variant="outline" onClick={() => form.reset()}>
										取消
									</Button>
									<Button
										onClick={() => form.handleSubmit()}
										disabled={!canSubmit}
									>
										{submitting ? '提交中…' : '提交'}
									</Button>
								</Group>
							</CardSection>
						)
					}
				</form.Subscribe>

				{debug && (
					<CardSection withBorder style={{ padding: '24px' }}>
						<form.Subscribe
							selector={(s) => [s.values, s.errorMap, s.errors] as const}
						>
							{([values, errorMap, errors]) => (
								<DebugValues formValues={{ values, errorMap, errors }} />
							)}
						</form.Subscribe>
					</CardSection>
				)}
			</Card>
		</form>
	)
}
