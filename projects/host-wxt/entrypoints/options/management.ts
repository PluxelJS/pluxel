import { pluginDefinitionIndexKey } from '@pluxel/core'
import type { HostConfigMutation, HostPluginConfigResult } from '@pluxel/host/embedded'
import { extractFormFields, type Schema } from 'valibot-form'
import { readRuleStates, withHost } from '../../src/application'
import type { RuleKey } from '../../src/rules'

function configError(result: Extract<HostPluginConfigResult, { ok: false }>) {
	if (result.code === 'revision_conflict')
		return new Error('配置版本已变化，请载入最新配置后再编辑。')
	if (result.code === 'validation_failed') {
		return new Error(
			Object.values(result.errors)
				.flatMap((fields) =>
					Object.values(fields).flatMap((issues) => issues.map((issue) => issue.message)),
				)
				.join('\n'),
		)
	}
	return new Error(result.message)
}

function isValibotSchema(schema: unknown): schema is Schema {
	return (
		typeof schema === 'object' && schema !== null && 'kind' in schema && schema.kind === 'schema'
	)
}

export async function readRules() {
	return withHost(async (host) => {
		const states = await readRuleStates(host)
		const entries = host.catalog().byDefinition
		return Promise.all(
			states.map(async ({ key, node, status, enabled, failure }) => {
				const { declaration } = entries.get(pluginDefinitionIndexKey(node.definition))!.candidate

				let form = null
				if (declaration.config) {
					const schema = declaration.config.schema
					if (!isValibotSchema(schema))
						throw new Error(`${status.displayName} 未提供可展示的 Valibot 对象配置`)
					const snapshot = await host.config.get(node)
					if (!snapshot.ok && snapshot.code !== 'validation_failed') throw configError(snapshot)
					form = {
						fields: extractFormFields(schema),
						saved: snapshot.managedInput ?? {},
						revision: snapshot.managedRevision,
						error: snapshot.ok ? '' : configError(snapshot).message,
					}
				}
				return { key, enabled, failure, status, form }
			}),
		)
	})
}

export type RuleView = Awaited<ReturnType<typeof readRules>>[number]
export type RuleForm = NonNullable<RuleView['form']>

export function writeRuleConfig(key: RuleKey, revision: string, change?: HostConfigMutation) {
	return withHost(async (host, rules) => {
		const node = rules[key].nodeAddress()
		const options = { expectedManagedRevision: revision }
		const result = change
			? await host.config.patch(node, change, options)
			: await host.config.reset(node, undefined, options)
		if (!result.ok) throw configError(result)
		return result
	})
}
