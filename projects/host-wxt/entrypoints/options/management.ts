import { pluginDefinitionIndexKey, pluginNodeAddressEqual } from '@pluxel/core'
import type { HostConfigMutation, HostPluginConfigResult } from '@pluxel/host/embedded'
import { extractFormFields, type Schema } from 'valibot-form'
import { applyPreferences, withHost } from '../../src/application'
import { ruleKeys, type RuleKey } from '../../src/rules'

function accepted(result: HostPluginConfigResult) {
	if (result.ok) return result
	if (result.code === 'revision_conflict')
		throw new Error('配置版本已变化，请载入最新配置后再编辑。')
	if (result.code === 'validation_failed') {
		throw new Error(
			Object.values(result.errors)
				.flatMap((fields) =>
					Object.values(fields).flatMap((issues) => issues.map((issue) => issue.message)),
				)
				.join('\n'),
		)
	}
	throw new Error(result.message)
}

function isValibotSchema(schema: unknown): schema is Schema {
	return (
		typeof schema === 'object' && schema !== null && 'kind' in schema && schema.kind === 'schema'
	)
}

export async function readRules() {
	await applyPreferences()
	return withHost(async (host, rules) => {
		const { statuses } = await host.status()
		const entries = host.catalog().byDefinition
		return Promise.all(
			ruleKeys.map(async (key) => {
				const node = rules[key].nodeAddress()
				const status = statuses.find((item) => pluginNodeAddressEqual(item.address, node))!
				const { declaration } = entries.get(pluginDefinitionIndexKey(node.definition))!.candidate

				if (!declaration.config) return { key, status, form: null }
				const schema = declaration.config.schema
				if (!isValibotSchema(schema))
					throw new Error(`${status.displayName} 未提供可展示的 Valibot 对象配置`)
				const snapshot = accepted(await host.config.get(node))
				return {
					key,
					status,
					form: {
						fields: extractFormFields(schema),
						saved: snapshot.managedInput ?? {},
						revision: snapshot.managedRevision,
					},
				}
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
		return accepted(
			change
				? await host.config.patch(node, change, options)
				: await host.config.reset(node, undefined, options),
		)
	})
}
