import { pluxel, type PluxelApplicationBuildOptions } from '@pluxel/rolldown'

pluxel({ delivery: 'modules', variant: 'headless' })
const options = {
	residualDependencies: { packages: ['native-driver'] },
} satisfies PluxelApplicationBuildOptions
pluxel(options)

// @ts-expect-error The application selects its Pg driver through its service imports.
pluxel({ managedDatabaseDrivers: [] })

const moduleResiduals = { delivery: 'modules', residualDependencies: ['native-driver'] } as const
// @ts-expect-error Modules keep external packages, without frozen residual copying.
pluxel(moduleResiduals)
// @ts-expect-error Transport startup belongs to the application launch callback.
pluxel({ launcher: 'node' })
// @ts-expect-error Framework facades were removed; shared identity is runtime admission.
pluxel({ sourceFrameworks: true })
