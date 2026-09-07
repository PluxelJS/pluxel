# OG image font

`LXGWWenKai-Regular.ttf` is the unmodified LXGW WenKai (霞鹜文楷) Regular font
from [lxgw/LxgwWenKai v1.522](https://github.com/lxgw/LxgwWenKai/releases/tag/v1.522).
It is distributed under the SIL Open Font License in [OFL.txt](./OFL.txt).

The OG renderer embeds this font through Vite's `?inline` asset import. Chinese
headings and descriptions therefore render without system fonts or network font
requests, including during static builds. This asset is for generated images;
it is not a web font downloaded by documentation readers.
