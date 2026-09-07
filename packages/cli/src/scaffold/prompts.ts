import { cancel, confirm, isCancel, select, text } from '@clack/prompts'
import type { TemplateContract, TemplatePrompt } from './contract'
import { scaffoldError } from './errors'
import { renderTemplateValue } from './render'

export async function collectTemplateAnswers(
	contract: TemplateContract,
	baseData: Readonly<Record<string, string>>,
	options: { interactive?: boolean } = {},
): Promise<Record<string, string> | null> {
	const reserved = new Set(Object.keys(baseData))
	const answers: Record<string, string> = {}
	const interactive = options.interactive ?? isInteractive()

	for (const prompt of contract.prompts) {
		if (reserved.has(prompt.name)) {
			throw scaffoldError(
				'TEMPLATE_CONTRACT_INVALID',
				`Template prompt "${prompt.name}" conflicts with a reserved input.`,
			)
		}
		const scope = { ...baseData, ...answers }
		const message = renderTemplateValue(prompt.message, scope, `prompt message (${prompt.name})`)
		if (!interactive) {
			answers[prompt.name] = resolvePromptDefault(prompt, scope)
			continue
		}

		if (prompt.type === 'confirm') {
			const result = await confirm({
				message,
				active: prompt.active,
				inactive: prompt.inactive,
				initialValue: prompt.default,
			})
			if (isCancel(result)) return cancelled()
			answers[prompt.name] = result ? 'true' : 'false'
			continue
		}

		if (prompt.type === 'select') {
			const result = await select({
				message,
				options: [...prompt.choices],
				initialValue: prompt.default,
			})
			if (isCancel(result)) return cancelled()
			answers[prompt.name] = String(result)
			continue
		}

		const result = await text({
			message,
			placeholder:
				prompt.placeholder === undefined
					? undefined
					: renderTemplateValue(prompt.placeholder, scope, `prompt placeholder (${prompt.name})`),
			defaultValue:
				prompt.default === undefined
					? undefined
					: renderTemplateValue(prompt.default, scope, `prompt default (${prompt.name})`),
		})
		if (isCancel(result)) return cancelled()
		answers[prompt.name] = String(result)
	}

	return answers
}

export async function confirmOverwrite(paths: readonly string[]): Promise<boolean | null> {
	const previewMax = 12
	const visible = paths
		.slice(0, previewMax)
		.map((path) => `- ${path}`)
		.join('\n')
	const more = paths.length > previewMax ? `\n… and ${paths.length - previewMax} more` : ''
	const result = await confirm({
		message: `Target has ${paths.length} existing file(s). Overwrite?${visible ? `\n${visible}` : ''}${more}`,
		initialValue: false,
	})
	if (isCancel(result)) return cancelled()
	if (!result) cancel('No changes made.')
	return result
}

function resolvePromptDefault(
	prompt: TemplatePrompt,
	scope: Readonly<Record<string, string>>,
): string {
	if (prompt.default === undefined) {
		throw scaffoldError(
			'TEMPLATE_CONTRACT_INVALID',
			`Non-interactive prompt "${prompt.name}" requires a default.`,
		)
	}
	if (prompt.type === 'confirm') return prompt.default ? 'true' : 'false'
	return renderTemplateValue(prompt.default, scope, `prompt default (${prompt.name})`)
}

function cancelled(): null {
	cancel('Scaffold cancelled.')
	return null
}

function isInteractive() {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY)
}
