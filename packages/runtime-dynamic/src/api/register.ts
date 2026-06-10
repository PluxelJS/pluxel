import {
	registerRuntimeMcpTools,
	registerRuntimeRpcHandle,
} from '@pluxel/runtime/api'
import { PackageManagerHandle } from './http/rpc/PackageManagerHandle'
import { registerWorkspaceMcpTools } from './mcp/workspace-tools'

import './graphql'

registerRuntimeRpcHandle('package', (ctx) => new PackageManagerHandle(ctx))
registerRuntimeMcpTools(registerWorkspaceMcpTools)
