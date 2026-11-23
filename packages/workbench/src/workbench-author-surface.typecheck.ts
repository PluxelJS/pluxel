import { defineServiceRef } from '@pluxel/core'
import type { Workbench } from '@pluxel/workbench'

const WorkbenchRef = defineServiceRef<Workbench>()
// These probes keep the Workbench author entry focused on the builder and the types that either
// consumers name directly or exported Plugin definitions need for declaration emit. Runtime wiring
// types stay internal.

type ContentActionResult = import('@pluxel/workbench').WorkbenchContentActionResult
type Principal = import('@pluxel/workbench').WorkbenchPrincipal
type View = import('@pluxel/workbench').WorkbenchView<never>
type Icon = import('@pluxel/workbench').WorkbenchIcon
type Attachment = import('@pluxel/workbench').WorkbenchAttachment<never>
type AttachmentPlacement = import('@pluxel/workbench').WorkbenchAttachmentPlacement<never>
type Content = import('@pluxel/workbench').WorkbenchContent
type ContentAction = import('@pluxel/workbench').WorkbenchContentAction
type ContentData = import('@pluxel/workbench').WorkbenchContentData<never>
type Definition = import('@pluxel/workbench').WorkbenchDefinition<{}>

// @ts-expect-error Implementation-level definition types are inferred by workbench.define().
type AnyDefinition = import('@pluxel/workbench').AnyWorkbenchDefinition
// @ts-expect-error PluginWorkbench is a Context service contract, not an author helper.
type PluginWorkbench = import('@pluxel/workbench').PluginWorkbench
// @ts-expect-error Open contexts are supplied contextually by ctx.service(WorkbenchRef).publish().
type AttachmentOpenContext = import('@pluxel/workbench').WorkbenchAttachmentOpenContext
// @ts-expect-error Target factories are supplied contextually by ctx.service(WorkbenchRef).publish().
type AttachmentTargetFactory = import('@pluxel/workbench').WorkbenchAttachmentTargetFactory
// @ts-expect-error Publication wiring is supplied contextually by ctx.service(WorkbenchRef).publish().
type Bindings = import('@pluxel/workbench').WorkbenchBindings
// @ts-expect-error Content bindings are supplied contextually by ctx.service(WorkbenchRef).publish().
type ContentBinding = import('@pluxel/workbench').WorkbenchContentBinding
// @ts-expect-error Content factories are supplied contextually by ctx.service(WorkbenchRef).publish().
type ContentFactory = import('@pluxel/workbench').WorkbenchContentFactory
// @ts-expect-error Schema constraints are inferred by workbench.data()/action().
type ContentSchema = import('@pluxel/workbench').WorkbenchContentSchema
// @ts-expect-error Content slots are inferred by workbench.content().
type ContentSlot = import('@pluxel/workbench').WorkbenchContentSlot
// @ts-expect-error Content slot maps are inferred by workbench.content().
type ContentSlotMap = import('@pluxel/workbench').WorkbenchContentSlotMap
// @ts-expect-error Entries are inferred from their exact descriptors.
type Entry = import('@pluxel/workbench').WorkbenchEntry
// @ts-expect-error Entry maps are inferred by workbench.define().
type EntryMap = import('@pluxel/workbench').WorkbenchEntryMap
// Reusable placement declarations can name the author input, with defaults left to the definition.
const placement = {
	kind: 'tab',
	label: 'Settings',
} satisfies import('@pluxel/workbench').WorkbenchPlacementInput

// @ts-expect-error Target factories are supplied contextually by ctx.service(WorkbenchRef).publish().
type TargetFactory = import('@pluxel/workbench').WorkbenchTargetFactory
// @ts-expect-error View open contexts are supplied contextually by ctx.service(WorkbenchRef).publish().
type ViewOpenContext = import('@pluxel/workbench').WorkbenchViewOpenContext

void (null as unknown as ContentActionResult)
void (null as unknown as Principal)
void (null as unknown as View)
void (null as unknown as Icon)
void (null as unknown as AnyDefinition)
void (null as unknown as PluginWorkbench)
void (null as unknown as Attachment)
void (null as unknown as AttachmentOpenContext)
void (null as unknown as AttachmentPlacement)
void (null as unknown as AttachmentTargetFactory)
void (null as unknown as Bindings)
void (null as unknown as ContentAction)
void (null as unknown as ContentBinding)
void (null as unknown as ContentData)
void (null as unknown as ContentFactory)
void (null as unknown as ContentSchema)
void (null as unknown as ContentSlot)
void (null as unknown as ContentSlotMap)
void (null as unknown as Definition)
void (null as unknown as Entry)
void (null as unknown as EntryMap)
void (null as unknown as Content)
void (null as unknown as TargetFactory)
void (null as unknown as ViewOpenContext)

void placement
