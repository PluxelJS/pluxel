import {
	createWorkbenchFederationCompatibilitySet,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { version as runtimeVersion } from '@pluxel/workbench/package.json'
import * as React from 'react'
import * as ReactDom from 'react-dom'

const compatibility = createWorkbenchFederationCompatibilitySet({
	react: React.version,
	reactDom: ReactDom.version,
	workbench: runtimeVersion,
})

export function federationManifest(
	plan: WorkbenchFederationProducerPlan,
	exposes = plan.entries.map((entry) => entry.expose),
) {
	const remotes: never[] = []
	return {
		id: plan.producer,
		name: plan.producer,
		metaData: {
			name: plan.producer,
			globalName: plan.producer,
			buildInfo: { buildVersion: plan.buildRevision, buildName: plan.producer },
			publicPath: 'auto',
			remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
			types: { path: '', name: '', api: 'types/index.d.ts', zip: '@mf-types.zip' },
			type: 'global',
		},
		remotes,
		shared: Object.entries(compatibility.shared).map(([name, version]) => ({
			name,
			version,
			requiredVersion: version,
			singleton: true,
			assets: assetGroup(),
		})),
		exposes: exposes.map((expose, index) => ({
			name: expose.slice(2),
			path: expose.slice(2),
			assets: assetGroup([`assets/view-${index}.js`]),
		})),
	}
}

function assetGroup(js: string[] = []): {
	js: { sync: string[]; async: string[] }
	css: { sync: string[]; async: string[] }
} {
	return {
		js: { sync: js, async: [] },
		css: { sync: [], async: [] },
	}
}
