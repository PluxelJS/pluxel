import { expectTypeOf } from 'vitest'
import {
	inspectPlugin,
	type InspectionSection,
	type InspectionSectionData,
} from '@pluxel/agent-sdk/source'

const context = { root: '/workspace' }
const reference = 'package:@fixture/mail::MailPlugin'
type ConfigSection = InspectionSection<InspectionSectionData['config']>
type PartsSection = InspectionSection<InspectionSectionData['parts']>

const literal = await inspectPlugin(reference, { ...context, include: ['config'] })
expectTypeOf(literal.data.sections.config).toEqualTypeOf<ConfigSection>()
expectTypeOf<keyof typeof literal.data.sections>().toEqualTypeOf<'config'>()

const include: ('config' | 'parts')[] = ['config']
const dynamic = await inspectPlugin(reference, { ...context, include })
expectTypeOf(dynamic.data.sections.config).toEqualTypeOf<ConfigSection | undefined>()
expectTypeOf(dynamic.data.sections.parts).toEqualTypeOf<PartsSection | undefined>()

const optionalOptions: { include?: readonly ['config'] } = {}
const optional = await inspectPlugin(reference, { ...context, ...optionalOptions })
expectTypeOf(optional.data.sections.config).toEqualTypeOf<ConfigSection | undefined>()

const omitted = await inspectPlugin(reference, context)
expectTypeOf<keyof typeof omitted.data.sections>().toEqualTypeOf<never>()

const application = { root: 'host', entry: 'a.ts' }
const inputs = await inspectPlugin(reference, { ...context, application, include: ['inputs'] })
expectTypeOf<keyof typeof inputs.data.sections>().toEqualTypeOf<'inputs'>()
expectTypeOf(inputs.data.sections.inputs).toEqualTypeOf<
	InspectionSection<InspectionSectionData['inputs']>
>()
const applicationIncludes: ('inputs' | 'config')[] = ['inputs']
const dynamicInputs = await inspectPlugin(reference, {
	...context,
	application,
	include: applicationIncludes,
})
expectTypeOf(dynamicInputs.data.sections.inputs).toEqualTypeOf<
	InspectionSection<InspectionSectionData['inputs']> | undefined
>()
