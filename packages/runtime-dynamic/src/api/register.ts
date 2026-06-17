import { registerRuntimeRpcHandle } from '@pluxel/runtime/api'
import { PackageManagerHandle } from './http/rpc/PackageManagerHandle'

import './graphql'

registerRuntimeRpcHandle('package', (ctx) => new PackageManagerHandle(ctx))
