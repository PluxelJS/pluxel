import { Alert, Text } from '@mantine/core'
import { makePathArray } from '@tanstack/react-form'
import type { ConfigValidationErrors } from '@pluxel/services/management/client'
import { useAutoFormCtx } from 'valibot-form/web'

type Issue = Readonly<{ message: string; path: readonly (string | number)[] }>
type FormFields = { fieldInfo: Partial<Record<string, { instance: unknown }>> }
type FieldErrors = Record<string, Array<{ message: string }>>

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
	const fields: FieldErrors = Object.create(null)
	for (const issue of issues) {
		const name = mountedName(issue.path, fieldNames)
		if (name === undefined) {
			form.push(issueSummary(issue))
			continue
		}
		;(fields[name] ??= []).push({ message: issue.message })
	}
	return { ...(form.length > 0 ? { form } : {}), fields }
}

export function mapConfigValidationErrors(
	errors: ConfigValidationErrors,
	sections: readonly { key: string; path: readonly string[]; mounted?: ReadonlySet<string> }[],
) {
	const issues = Object.values(errors).flatMap((group) => Object.values(group).flat())
	const summary: string[] = []
	const fieldsBySection = new Map<string, FieldErrors>()
	for (const issue of issues) {
		const owner = sections.reduce<(typeof sections)[number] | undefined>(
			(current, section) =>
				(!current || section.path.length > current.path.length) &&
				section.path.every((segment, index) => issue.path[index] === segment)
					? section
					: current,
			undefined,
		)
		const field = owner?.mounted && mountedName(issue.path.slice(owner.path.length), owner.mounted)
		if (!owner || field === undefined) {
			summary.push(issueSummary(issue))
			continue
		}
		let fields = fieldsBySection.get(owner.key)
		if (!fields) {
			fields = Object.create(null) as FieldErrors
			fieldsBySection.set(owner.key, fields)
		}
		;(fields[field] ??= []).push({ message: issue.message })
	}
	return { fieldsBySection, summary }
}

function mountedName(path: Issue['path'], names: ReadonlySet<string>): string | undefined {
	const name = path
		.map((part, index) => (typeof part === 'number' ? `[${part}]` : `${index ? '.' : ''}${part}`))
		.join('')
	if (!name || !names.has(name)) return undefined
	const parsed = makePathArray(name)
	return parsed.length === path.length && parsed.every((part, index) => part === path[index])
		? name
		: undefined
}

function issueSummary({ path, message }: Issue): string {
	const label = path.reduce<string>(
		(prefix, part) =>
			typeof part === 'string' && /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(part)
				? `${prefix}.${part}`
				: `${prefix}[${JSON.stringify(part)}]`,
		'$',
	)
	return `${label} · ${message}`
}

export function ValidationSummary({ messages }: { messages: readonly string[] }) {
	return messages.length > 0 ? (
		<Alert color="red" title="提交内容有误" variant="light">
			{messages.map((message, index) => (
				<Text key={index} size="sm">
					{message}
				</Text>
			))}
		</Alert>
	) : null
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
				return <ValidationSummary messages={messages} />
			}}
		</form.Subscribe>
	)
}
