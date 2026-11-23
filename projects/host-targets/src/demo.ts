import { createScriptScope, type ScriptSdk } from '@pluxel/agent-sdk/host'
import type { Consumer } from '@pluxel-example/host-targets-plugins'
import { formatPluginNodeReference, type PluginInstanceNodeAddress } from '@pluxel/core'
import type { PluginHost, PluginApplyReport } from '@pluxel/host'
import type { DemoHost, DemoResult } from './protocol'

export { demoApplication, demoInputs } from './demo-plugins'

type ConsumerAddress =
	| PluginInstanceNodeAddress<Consumer>
	| ReturnType<typeof import('@pluxel-example/host-targets-plugins/control').Consumer.nodeAddress>
type DemoInvocation = { address: ConsumerAddress; target: DemoHost; signal?: AbortSignal }

export async function runDemo(host: PluginHost, input: DemoInvocation): Promise<DemoResult> {
	await using scope = createScriptScope({ ctx: host.ctx, signal: input.signal })
	return await readDemo(scope.sdk, input)
}

export async function readDemo(
	sdk: ScriptSdk,
	{ address, target, signal }: DemoInvocation,
): Promise<DemoResult> {
	const { instance } = await sdk.plugin(address).instance()
	const greeting = await instance.greet(signal)
	return { host: target, plugin: formatPluginNodeReference(address), ...greeting }
}

export function assertDemoUpdate(report: PluginApplyReport | undefined) {
	if (!report) return
	const issues = report.reconciliation
	if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('\n'))
	if (report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
		throw new Error(
			report.core.summary.lifecycleReport.issues.map((issue) => issue.message).join('\n'),
		)
}
