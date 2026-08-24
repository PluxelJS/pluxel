import type { RawInputProjection } from 'valibot-form'

export type StaticConfigEnvironmentTarget = Readonly<{
	environmentName: string
	pluginName: string
	schemaName: string
	path: readonly string[]
	projection: RawInputProjection
}>

export function renderStaticConfigEnvironmentExample(
	targets: readonly StaticConfigEnvironmentTarget[],
): string | undefined {
	if (targets.length === 0) return undefined
	const grouped = new Map<string, StaticConfigEnvironmentTarget[]>()
	for (const target of targets) {
		const group = grouped.get(target.environmentName)
		if (group) group.push(target)
		else grouped.set(target.environmentName, [target])
	}
	const lines = [
		'# Generated Pluxel static config bootstrap variables.',
		'# Existing persisted config remains authoritative.',
		'',
	]
	for (const environmentName of [...grouped.keys()].sort(compareUtf8)) {
		const group = grouped.get(environmentName)!
		const descriptions = new Set<string>()
		const inputs = new Set<string>()
		for (const target of group) {
			for (const description of target.projection.descriptions) descriptions.add(description)
			inputs.add(target.projection.inputDescription)
		}
		for (const description of [...descriptions].sort(compareUtf8)) {
			for (const line of commentLines(description)) lines.push(`# ${line}`)
		}
		for (const input of [...inputs].sort(compareUtf8)) lines.push(`# Input: ${input}`)
		lines.push(`# ${environmentName}=`, '')
	}
	return `${lines.slice(0, -1).join('\n')}\n`
}

function commentLines(value: string): string[] {
	return value.replaceAll(/\r\n?/g, '\n').split('\n')
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}
