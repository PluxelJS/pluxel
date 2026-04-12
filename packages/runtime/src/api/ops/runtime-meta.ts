import type { Context } from '@pluxel/core'
import { type OpPublicDescriptor } from '@pluxel/ops'

import type { RuntimeOperation } from '../../services/ops/OpsService'
import { defineRuntimeOp } from './helpers'
import { emptyInputSchema, runtimeOpsDescriptorSchema } from './schemas'

type RuntimeMetaDeps = {
	listRuntimeOps: (ctx: Context) => OpPublicDescriptor[]
}

export function createRuntimeMetaOps(deps: RuntimeMetaDeps): readonly RuntimeOperation[] {
	const runtimeOpsListOp = defineRuntimeOp({
		id: 'runtime.ops.list',
		doc: {
			title: 'List Runtime Ops',
			description: 'List currently registered runtime operations and their schemas.',
		},
		input: emptyInputSchema,
		output: runtimeOpsDescriptorSchema,
		exposure: { rpc: true },
		policy: { idempotent: true },
		tool: true,
		cli: {
			triggers: ['runtime ops list'],
		},
		async execute(_input, opCtx) {
			return deps.listRuntimeOps(opCtx.runtime)
		},
	})

	return Object.freeze([runtimeOpsListOp])
}
