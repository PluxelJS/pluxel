---
packages:
  '@pluxel/workbench': minor
  '@pluxel/core': minor
  '@pluxel/services': patch
  '@pluxel/plugin-fonts': patch
  '@pluxel/plugin-wretch': patch
  '@pluxel/plugin-auth': patch
---

## Linear-style Workbench theme shared with Plugin renderers

The Workbench Shell uses a quieter, layered look: toolbar, activity rail, tab bars and side
panels sit on one canvas, and centre documents float as rounded panels. Body text is 13px
with matching control heights, floating layers carry the only shadows, and icon buttons are
subtle by default.

`@pluxel/workbench/mantine` exports `workbenchTheme` and `WorkbenchMantineProvider`. Plugin
renderers wrap their root in `<WorkbenchMantineProvider colorScheme={host.colorScheme}>` to
share the Shell's scale, fonts, colour names and component defaults. The Provider leaves CSS
variables to the Shell, so renderers follow the user's accent and colour scheme instead of
overriding them with Mantine defaults. The module is a Workbench Module Federation shared
singleton, added to `WORKBENCH_FEDERATION_SHARED_MODULES`.

`workbenchTheme` defaults `Text` to `sm` (13px), sizes Badge labels for CJK, lists system UI
fonts before CJK fonts, and uses shade 7 for filled controls so white labels meet WCAG AA for
every accent. The Shell renders `light` variants as a translucent tint with a readable label
in the same hue, and gives dark floating layers deeper shadows and dark tooltips.

Route documents use `p="lg"` and panels `p="sm"`, the same insets as Shell pages; the Shell
does not pad renderer containers.

The packaged Shell handler now emits imported chunks' stylesheets before the entry's own, so
Shell styles override Mantine's base rules as intended.

Built-in renderers in `@pluxel/services`, `@pluxel/plugin-fonts`, `@pluxel/plugin-wretch` and
`@pluxel/plugin-auth` use the new Provider.
