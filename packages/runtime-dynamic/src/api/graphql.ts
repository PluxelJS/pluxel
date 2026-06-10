import { registerRuntimeApiResolver } from '@pluxel/runtime/api'

import { createPackageManagerResolver } from './features/package-manager/resolver'

registerRuntimeApiResolver(createPackageManagerResolver)
