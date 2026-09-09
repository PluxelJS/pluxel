import { Alert, Text } from '@mantine/core'
import { makePathArray } from '@tanstack/react-form'
import type { ConfigValidationErrors } from '@pluxel/runtime/web'
import { useAutoFormCtx } from 'valibot-form/web'

type Issue = Readonly<{ message: string; path: readonly (string | number)[] }>
type FormFields = { fieldInfo: Partial<Record<string, { instance: unknown }>> }

export function mountedFieldNames(form: FormFields): ReadonlySet<string> {
	return new Set(
		Object.entries(form.fieldInfo).flatMap(([name, info]) => (info?.instance ? [name] : [])),
	)
}

/** Only route paths that survive TanStack's parser without changing their meaning. */
export function mapServerValidationIssues(
	issues: readonly Issue[],
	fieldNames: ReadonlySet<string>,
) {
	const form: string[] = []
	const fields: Record<string, Array<{ message: string }>> = Object.create(null)
	for (const issue of issues) {
		const name = issue.path
			.map((segment, index) =>
				typeof segment === 'number' ? `[${segment}]` : `${index ? '.' : ''}${segment}`,
			)
			.join('')
		const parsed = makePathArray(name)
		if (
			!name ||
			parsed.length !== issue.path.length ||
			parsed.some((segment, index) => segment !== issue.path[index]) ||
			!fieldNames.has(name)
		) {
			form.push(issue.message)
			continue
		}
		;(fields[name] ??= []).push({ message: issue.message })
	}
	return { ...(form.length > 0 ? { form } : {}), fields }
}

export function mapConfigValidationErrors(
	errors: ConfigValidationErrors,
	fieldNames: ReadonlySet<string>,
	sectionPath: readonly string[],
) {
	const issues = Object.values(errors)
		.flatMap((group) => Object.values(group).flat())
		.map((issue) => {
			const belongs = sectionPath.every((segment, index) => issue.path[index] === segment)
			return {
				message: issue.message,
				// Config transport stringifies indices. Numeric object keys are not independently bound.
				path: belongs
					? issue.path
							.slice(sectionPath.length)
							.map((segment) => (/^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : segment))
					: [],
			}
		})
	return mapServerValidationIssues(issues, fieldNames)
}

export function ServerValidationSummary() {
	const { form } = useAutoFormCtx()
	return (
		<form.Subscribe selector={(state) => state.errorMap.onServer}>
			{(serverError) => {
				const error: unknown = serverError
				const messages =
					typeof error === 'string'
						? [error]
						: Array.isArray(error)
							? error.filter((message): message is string => typeof message === 'string')
							: []
				return messages.length > 0 ? (
					<Alert color="red" title="提交内容有误" variant="light">
						{messages.map((message, index) => (
							<Text key={index} size="sm">
								{message}
							</Text>
						))}
					</Alert>
				) : null
			}}
		</form.Subscribe>
	)
}
