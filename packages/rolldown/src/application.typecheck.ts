import { pluxel } from './application'

pluxel({ delivery: 'modules', variant: 'headless' })
pluxel({ delivery: 'standalone', launcher: 'node' })

const moduleLauncher = { delivery: 'modules', launcher: 'node' } as const
// @ts-expect-error Modules export a factory; only standalone owns a launcher.
pluxel(moduleLauncher)
const moduleResiduals = { delivery: 'modules', residualDependencies: ['native-driver'] } as const
// @ts-expect-error Modules keep external packages, without frozen residual copying.
pluxel(moduleResiduals)
// @ts-expect-error Framework facades were removed; shared identity is runtime admission.
pluxel({ sourceFrameworks: true })
