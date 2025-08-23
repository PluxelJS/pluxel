import { formOptions } from '@tanstack/react-form'
import { AutoForm } from '.'
import * as v from 'valibot'
import * as f from 'valibot-form'
import { Box, ScrollArea, Button, Group } from '@mantine/core'
import * as schema from './schema'

const UserSchema = v.object({
	id: v.pipe(
		v.number(),
		f.numberMeta({
			type: 'slider',
			options: {
				min: 0,
				max: 100,
				step: 5,
				marks: [
					{ value: 0, label: '0' },
					{ value: 5, label: '5' },
					{ value: 10, label: '10' },
				],
			},
		}),
		v.maxValue(10), // 注意：UI 允许到 100，但校验限制为 ≤10
	),
	color: v.optional(v.pipe(v.string(), v.hexColor()), '#000000'),
	name: v.optional(v.pipe(v.string(), v.minLength(2)), 'a'),
	check: v.optional(v.boolean(), true),
})

const UsingSchema = schema.PicklistSmartSchema

export function Home() {
	return (
		<AutoForm
			schema={UsingSchema}
			formOpts={formOptions({
				validators: {
					onChange: ({ value, formApi }) => {
						const r = v.safeParse(UsingSchema, value)
						if (r.success) return
						const fields: Record<
							string,
							{ message: string; dotPath: string }[]
						> = {}
						for (const issue of r.issues) {
							const path = (v.getDotPath(issue) ?? 'unknown').split('.')
							const name = path[0]
							fields[name] = (fields[name] ?? []).concat({
								message: issue.message,
								dotPath: path,
							})
						}
						return { fields }
					},
				},
			})}
		>
			<AutoForm.Actions>
				{({ submit, reset, dirty, canSubmit, submitting }) => (
					<Group gap="sm" justify="flex-end">
						<Button
							variant="default"
							onClick={() => reset()}
							disabled={!dirty || submitting}
							type="button"
						>
							取消
						</Button>
						<Button
							onClick={() => submit()}
							disabled={!canSubmit}
							loading={submitting}
							type="button"
						>
							{submitting ? '提交中…' : '提交'}
						</Button>
					</Group>
				)}
			</AutoForm.Actions>

			<ScrollArea
				style={{ flex: 1, minHeight: 0 }}
				offsetScrollbars
				type="hover"
			>
				<Box px="sm" pb={96 /* 留出悬浮操作区的高度余量 */}>
					<AutoForm.Fields />
				</Box>
			</ScrollArea>

			<AutoForm.DebugPanel />
		</AutoForm>
	)
}
