import type { AnyHostElysiaApp } from '../../services/http/elysia'
import { createWorkbenchArtifactHandler } from '@pluxel/workbench/server'
import { RUNTIME_WORKBENCH_FEDERATION_BASE } from '@pluxel/workbench/paths'

/** Runtime's route adapter delegates immutable file serving to the installed Workbench backend. */
export const workbenchRoutes = (app: AnyHostElysiaApp) =>
	app.group(RUNTIME_WORKBENCH_FEDERATION_BASE, (federation) =>
		federation.get(
			'/:producer/:revision/*',
			async ({ pluginCtx, request, status }) =>
				(await createWorkbenchArtifactHandler(pluginCtx)(request)) ??
				status(404, 'Federation artifact not found'),
		),
	)
