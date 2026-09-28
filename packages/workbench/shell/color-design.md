# Workbench visual policy

Mantine owns component structure and baseline appearance. Pluxel owns shell layout and semantic colors. Theme implementation lives in [src/theme](./src/theme/README.md); repository constraints are in [UI_LIBRARY.md](../../../engineering/UI_LIBRARY.md).

- Use Mantine props first, local `style/styles` with semantic variables second; global SCSS is for shell/workbench layout and neutral surfaces shared by unrelated screens.
- Accent marks emphasis, selection and focus; neutral surfaces express structure; error/warning/success retain semantic colors. Text legibility takes precedence over palette uniformity.
- Do not repaint component families through theme `components:` overrides or global `plx-theme-*` skins. Correctness/localization defaults, including existing CJK text normalization, are allowed.
- No raw hex in business UI, decorative background tokens, or bordered wrappers around a lone field merely for polish.
- A shared token, primitive or Mantine extension API needs at least two unrelated consumers and a clear contract. Use ordinary Mantine controls otherwise.
- Custom shell layout, organizer drag feedback and plugin workbench layout are intentional structural styling; they do not create another button/input/card system.

Color flow: accent presets → semantic `--plx-*` variables → Mantine configuration and layout consumers. Keep a single authority for each color.
