// These negative type probes keep Runtime's source and generated root declarations from restoring
// PluginPart occurrence internals through a public or test entry point.

// @ts-expect-error PluginPartContext is not a Runtime root export.
type PluginPartContext = import('@pluxel/runtime').PluginPartContext
// @ts-expect-error PluginPartInfo is not a Runtime root export.
type PluginPartInfo = import('@pluxel/runtime').PluginPartInfo
// @ts-expect-error PluginPartOwner is not a Runtime root export.
type PluginPartOwner = import('@pluxel/runtime').PluginPartOwner
// @ts-expect-error PluginParts is not a Runtime root export.
type PluginParts = import('@pluxel/runtime').PluginParts

// @ts-expect-error Runtime's test root does not restore removed author-surface types.
type TestPluginPartContext = import('@pluxel/runtime/test').PluginPartContext
// @ts-expect-error Runtime's test root does not restore removed author-surface types.
type TestPluginPartInfo = import('@pluxel/runtime/test').PluginPartInfo
// @ts-expect-error Runtime's test root does not restore removed author-surface types.
type TestPluginPartOwner = import('@pluxel/runtime/test').PluginPartOwner
// @ts-expect-error Runtime's test root does not restore removed author-surface types.
type TestPluginParts = import('@pluxel/runtime/test').PluginParts

// @ts-expect-error The shared test package also keeps occurrence internals private.
type SharedTestPluginPartContext = import('@pluxel/test').PluginPartContext
// @ts-expect-error The shared test package also keeps occurrence internals private.
type SharedTestPluginPartInfo = import('@pluxel/test').PluginPartInfo
// @ts-expect-error The shared test package also keeps occurrence internals private.
type SharedTestPluginPartOwner = import('@pluxel/test').PluginPartOwner
// @ts-expect-error The shared test package also keeps occurrence internals private.
type SharedTestPluginParts = import('@pluxel/test').PluginParts

void (null as unknown as PluginPartContext)
void (null as unknown as PluginPartInfo)
void (null as unknown as PluginPartOwner)
void (null as unknown as PluginParts)
void (null as unknown as TestPluginPartContext)
void (null as unknown as TestPluginPartInfo)
void (null as unknown as TestPluginPartOwner)
void (null as unknown as TestPluginParts)
void (null as unknown as SharedTestPluginPartContext)
void (null as unknown as SharedTestPluginPartInfo)
void (null as unknown as SharedTestPluginPartOwner)
void (null as unknown as SharedTestPluginParts)
