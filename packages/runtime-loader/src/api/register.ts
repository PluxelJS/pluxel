import {
	registerRuntimeApiResolver,
	registerRuntimeMcpTools,
	registerRuntimeRpcHandle,
} from '@pluxel/runtime/api'
import { createPackageManagerResolver } from './features/package-manager/resolver'
import { PackageManagerHandle } from './http/rpc/PackageManagerHandle'
import { registerWorkspaceMcpTools } from './mcp/workspace-tools'

registerRuntimeApiResolver(createPackageManagerResolver)
registerRuntimeRpcHandle('package', (ctx) => new PackageManagerHandle(ctx))
registerRuntimeMcpTools(registerWorkspaceMcpTools)
