import { discoverStudio, withStudio } from '@report-template-studio/app/client'
import { isStudioError, type JsonObject } from '@report-template-studio/app/contracts'

/** Selection comes from the caller; this function never starts or chooses a backend for them. */
export async function inspectReport(input: {
	selectedInstanceId: string
	selectedProjectRoot: string
	entry: string
	data: JsonObject
	discoveryDirectory?: string
}) {
	try {
		const instances = await discoverStudio({ discoveryDirectory: input.discoveryDirectory })
		const instance = instances.find((item) => item.instanceId === input.selectedInstanceId)
		if (!instance) throw new Error('所选 Studio 实例不可用，请重新发现')
		return await withStudio(instance, async (studio) => {
			const projects = await studio.listProjects()
			const project = projects.find((item) => item.root === input.selectedProjectRoot)
			if (!project) throw new Error('请先明确选择或打开目标项目')
			const target = { projectId: project.id, entry: input.entry }
			const compiled = await studio.compile({ ...target, data: input.data })
			const page = await studio.renderPage({
				...target,
				revision: compiled.revision,
				page: compiled.pageCount,
				scale: 2,
			})
			const pdf = await studio.exportPdf({ ...target, revision: compiled.revision })
			return { revision: compiled.revision, page, pdf }
		})
	} catch (error) {
		console.error(
			isStudioError(error)
				? {
						code: error.code,
						message: error.message,
						diagnostics: error.diagnostics,
						issues: error.issues,
					}
				: error,
		)
		throw error
	}
}
