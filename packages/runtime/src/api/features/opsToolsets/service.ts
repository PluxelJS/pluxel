import type { Context as PlxContext } from '@pluxel/core'

import type { OpsToolsetInputValue, OpsToolsetOutput } from '../../../services'

export function readOpsToolsets(pCtx: PlxContext): OpsToolsetOutput[] {
	return pCtx.ops.toolsets.list()
}

export function writeOpsToolsets(
	pCtx: PlxContext,
	toolsets: OpsToolsetInputValue[],
): OpsToolsetOutput[] {
	return pCtx.ops.toolsets.write(toolsets)
}
