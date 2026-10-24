import { expectTypeOf } from 'vitest'
import type {
	ProjectInspection,
	InspectionSection,
	InspectionSectionData,
} from '../src/inspect/index'

declare const project: ProjectInspection
const reference = 'package:@fixture/mail::MailPlugin'
type ConfigSection = InspectionSection<InspectionSectionData['config']>
type PartsSection = InspectionSection<InspectionSectionData['parts']>

const literal = await project.plugin(reference, { include: ['config'] })
expectTypeOf(literal.data.sections.config).toEqualTypeOf<ConfigSection>()
expectTypeOf<keyof typeof literal.data.sections>().toEqualTypeOf<'config'>()

const include: ('config' | 'parts')[] = ['config']
const dynamic = await project.plugin(reference, { include })
expectTypeOf(dynamic.data.sections.config).toEqualTypeOf<ConfigSection | undefined>()
expectTypeOf(dynamic.data.sections.parts).toEqualTypeOf<PartsSection | undefined>()

const optionalOptions: { include?: readonly ['config'] } = {}
const optional = await project.plugin(reference, optionalOptions)
expectTypeOf(optional.data.sections.config).toEqualTypeOf<ConfigSection | undefined>()

const omitted = await project.plugin(reference)
expectTypeOf<keyof typeof omitted.data.sections>().toEqualTypeOf<never>()

const application = { root: 'host', entry: 'a.ts' }
const inputs = await project.plugin(reference, { application, include: ['inputs'] })
expectTypeOf<keyof typeof inputs.data.sections>().toEqualTypeOf<'inputs'>()
expectTypeOf(inputs.data.sections.inputs).toEqualTypeOf<
	InspectionSection<InspectionSectionData['inputs']>
>()
const applicationIncludes: ('inputs' | 'config')[] = ['inputs']
const dynamicInputs = await project.plugin(reference, { application, include: applicationIncludes })
expectTypeOf(dynamicInputs.data.sections.inputs).toEqualTypeOf<
	InspectionSection<InspectionSectionData['inputs']> | undefined
>()
