import type { CoreFacilitiesConfig } from '../context/Context'
import { snapshotCoreFacilities, type PreparedCoreFacilities } from '../context/core-facilities'
import { FsService, snapshotFsConfig } from '../fs/service'
import type { ProxyDispatcherFactory } from '../http/options'

/** Prepare file-backed facilities for a Host that supplies ZenFS. */
export function snapshotZenFsCoreFacilitiesConfig(
	input: CoreFacilitiesConfig = {},
	createProxyDispatcher?: ProxyDispatcherFactory,
): PreparedCoreFacilities {
	return snapshotCoreFacilities(
		input,
		(zenfs) => {
			const config = snapshotFsConfig(zenfs === undefined ? {} : zenfs)
			return (root) => {
				const files = new FsService(root, config)
				return { documents: files, files }
			}
		},
		createProxyDispatcher,
	)
}
