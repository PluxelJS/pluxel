import { pluxel, type PluxelApplicationBuildOptions } from '@pluxel/rolldown'

pluxel({ delivery: 'modules', variant: 'headless' })
pluxel({ managedDatabaseDrivers: [] })
pluxel({ delivery: 'standalone', managedDatabaseDrivers: ['pglite', 'postgres'] })

const drivers: readonly ('pglite' | 'postgres')[] = ['postgres']
const options = { managedDatabaseDrivers: drivers } satisfies PluxelApplicationBuildOptions
pluxel(options)

// @ts-expect-error Native module delivery does not select bundled managed drivers.
pluxel({ delivery: 'modules', managedDatabaseDrivers: [] })
// @ts-expect-error Application-private drivers belong in residualDependencies.
pluxel({ managedDatabaseDrivers: ['libsql'] })

const moduleResiduals = { delivery: 'modules', residualDependencies: ['native-driver'] } as const
// @ts-expect-error Modules keep external packages, without frozen residual copying.
pluxel(moduleResiduals)
// @ts-expect-error Transport startup belongs to the application launch callback.
pluxel({ launcher: 'node' })
// @ts-expect-error Framework facades were removed; shared identity is runtime admission.
pluxel({ sourceFrameworks: true })
