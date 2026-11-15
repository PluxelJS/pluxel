import {
	runScript,
	getScriptResult,
	controlHmr,
	syncPluginControl,
	type HostTarget,
} from '@pluxel/agent-sdk/client'

declare const target: HostTarget
void runScript({
	target,
	file: 'task.ts',
	onPrepared: async (receipt) => {
		const saved: string = receipt
		void saved
	},
})
// @ts-expect-error An operation selects one process domain.
void runScript({ target: { root: '.', endpoint: 'https://host.test' }, file: 'task.ts' })
// @ts-expect-error Receipt queries cannot be redirected to another target.
void getScriptResult('receipt', { target: { root: '.' } })
// @ts-expect-error HMR belongs to a development instance.
void controlHmr({ target: { endpoint: 'https://host.test' }, action: 'apply' })
// @ts-expect-error Material publication requires an explicit destination.
void syncPluginControl({ target })
