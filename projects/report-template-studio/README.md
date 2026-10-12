# Pluxel Typst Studio

本地文件工作区式报表编辑器：用 Explorer 打开文件，用 Worksplit 标签页组织源码、Valibot 表单和 Typst 实时预览；Pi 直接在当前项目内阅读和修改文件。项目就是普通目录，可以交给其他 coding agent 编辑，也可以整体导出 ZIP。

## 运行与打包

使用仓库 `mise.toml` 固定的 Node / pnpm；原生 Typst 构建需要 Git 和 Rust 1.97.1。在仓库根目录执行：

```sh
pnpm install
rustup toolchain install 1.97.1 --profile minimal
pnpm --filter '@report-template-studio/app^...' --if-present build
pnpm --filter @report-template-studio/app dev
```

`dev` 先准备官方 Typst 原生编译器，再启动 Vite renderer 与 Electron，自动移除子进程继承的 `ELECTRON_RUN_AS_NODE`。首次构建会获取固定提交的上游源码并编译，后续复用同一构建缓存。原生库位于 `plugins/render/typst/native/compiler.node`，依赖图、源码映射和原生构建契约由该插件维护。单实例锁保护已经打开的窗口；开始新的开发会话前关闭旧窗口。`start` 运行已有 `dist/` 构建。

| 修改位置                                                                                       | 开发时的更新方式                                                                 |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `src/renderer/` React 组件、样式                                                               | Vite HMR / React Fast Refresh；不兼容的组件边界由 Vite 刷新页面                  |
| `src/backend/` 插件及依赖、应用声明                                                            | utility process 内的官方 `@pluxel/host-vite` 接纳源码更新；Electron 窗口无需重启 |
| `src/electron/` 主进程、preload、IPC 壳，`src/backend/dev.ts` 开发引导，`tsdown.dev.config.ts` | 请求窗口正常关闭，等待后端释放资源后重新构建并启动 Electron                      |
| 当前项目里的报表入口、依赖和 Typst 文件                                                        | 工作区监听与现有文档 Vite 模块图更新表单、诊断和预览                             |

主进程重启遵守窗口的未保存内容关闭保护。取消关闭就取消这次自动重启，现有窗口与开发服务器继续运行；保存后再次修改壳源码即可重试。构建错误会留在终端，修正文件后自动重试。React Fast Refresh 尽量保留可兼容的组件状态，不承诺跨页面刷新或主进程重启保留尚未保存的草稿。

开发壳输出到 `.studio-dev/`，生产构建输出到 `dist/`，互不覆盖。开发时只有 renderer 在 `127.0.0.1` 动态端口提供 HTTP / WebSocket，用于页面资源和 HMR；业务使用 Cap’n Web：renderer 通过 MessagePort 读取二进制预览，外部程序通过本机 Unix socket / Windows named pipe 调用同一服务；后端没有 TCP/HTTP 业务 listener。退出应用会关闭该开发会话的 Vite 服务器。前端和后端分别使用 `.studio-dev/vite-renderer` 与 `.studio-dev/vite-backend` 缓存，避免不同 Vite 配置互相使依赖预构建失效。

启动参数可继续传给 Electron。例如本机 Linux Wayland 遇到 SUID sandbox helper 配置错误时，可以显式使用以下开发启动方式；这些参数不会成为应用默认配置：

```sh
pnpm --filter @report-template-studio/app dev -- --no-sandbox --ozone-platform=wayland --disable-gpu
```

### 检查正在运行的后端

Linux / macOS 开发后端启用官方开发控制台，通过本机 Unix socket 操作当前 Host；Windows 暂时关闭这个控制台，因为其 socket 传输尚不支持 Windows。该限制不改变 Electron IPC 或后端 HMR 的接线方式，Windows 桌面运行仍需独立验证。

在仓库根目录执行，固定当前 checkout 的绝对项目路径：

```sh
studio_root="$(pwd)/projects/report-template-studio"
pnpm pluxel dev instances --root "$studio_root"
# 将 INSTANCE_ID 替换为上一步返回且 root、pid 匹配的 instanceId
pnpm pluxel dev run "$studio_root/dev/inspect.ts" --root "$studio_root" --instance INSTANCE_ID
```

[`dev/inspect.ts`](dev/inspect.ts) 返回当前插件状态与最近一次更新；后续命令继续使用同一个绝对 `--root` 和已确认的 `--instance`。应用壳重启后先重新发现实例。完整回执与在线操作规则见[开发控制台指南](../../docs/development/dev-console.md)。

### 生产构建与打包

```sh
pnpm --filter '@report-template-studio/app^...' --if-present build
pnpm --filter @report-template-studio/app build
pnpm --filter @report-template-studio/app package
```

`release/PluxelTypstStudio-<platform>-<arch>/` 输出当前系统和架构的独立应用目录。`pnpm deploy` 只安装生产依赖，使用 hoisted 目录避免 pnpm 链接及 Windows junction 进入发布包；打包前拒绝剩余依赖链接。原生 Typst、字体、Worker 和 QuickJS WASM 保持真实文件，整个目录可复制到另一处启动。构建产物不包含用户项目、AI 凭据或本机应用数据。

[Typst Studio Windows Action](../../.github/workflows/report-template-studio-windows.yml) 支持手动执行，也在 `main` 上的相关源码变更后运行；使用相同 Node / pnpm、Rust 1.97.1 和打包脚本，构建 Windows x64 原生库，执行仅允许本机 IPC、禁止 TCP/HTTP 业务监听的生产后端检查，再上传便携应用 ZIP。归档包含项目指引的 `.agents/skills/`。下载产物后解压，运行 `pluxel-typst-studio.exe`；该任务提供构建产物，未增加安装器、签名或自动更新。Linux 本机验证不能替代 Windows 桌面交互验收。

## 使用

首页提供“财务报表 Starter”：填项目名称并新建，即复制默认字体、共享主题和三个带演示默认值的财务文档，打开后自动显示第一个文档的表单与预览；也可打开已有本地目录、从最近列表切换项目，或导入 ZIP。应用创建的项目位于 Electron `userData/studio` 下；打开已有目录直接编辑原文件。“移除记录”只删除最近列表记录。

`dev` 和 `start` 使用同一个 Electron 系统应用数据目录，开发构建只更新 `.studio-dev/`、生产构建只更新 `dist/`，不会清空项目。项目文件位于 `userData/studio/workspaces/projects/`，最近列表为 `userData/studio/workspaces/recent.json`，填写数据为 `userData/studio/inputs/`。这里的 `userData` 由 Electron 按操作系统确定；在 Flatpak 中属于该应用沙箱的配置目录。重启后从首页“最近项目”打开即可继续。只有桌面自动测试才显式使用临时 profile；正常启动不要传每次变化的 `--user-data-dir`。

左侧文件树支持创建目录/文件、重命名/移动、删除和资产导入。文件和目录的右键菜单提供管理操作，键盘也可操作菜单。报表目录及其同名 TypeScript 入口有专用标记；点击报表打开填写表单和右侧预览，左侧可切换“表单 / 代码”。普通文本文件打开源码标签页；`.typ` 是源码和共享模块，不作为独立预览入口。标签页可以拖动分屏。布局使用 **Worksplit `refactor/flexlayout-tanstack` 的 `7768656250cea1e6c32d04373e3eccd5ad49f4fa` 提交**，详见 [vendor/README.md](vendor/README.md)。其他组件使用 Mantine。

分组使用 FlexLayout 原生关闭按钮，关闭经过 Worksplit 的文档生命周期，保留保存和取消检查。关闭最后一个标签后，多余空分屏自动回收；再次打开报表按当前布局选择编辑组，并在需要时创建右侧预览组，不依赖已删除分组的固定 ID。

文件和目录的右键菜单提供“在系统文件管理器中显示”，项目菜单和文件树空白处菜单可以打开项目根目录。Electron 根据已登记项目解析真实磁盘位置；不接收任意系统路径。源码、字体和图片都是磁盘文件，可直接交给外部工具编辑；`/inputs/` 是编译虚拟输入，不会作为磁盘文件显示。

源码自动保存。外部编辑器或 coding agent 保存的文件会自动载入并更新已打开的预览。文件内容版本用于检测并发编辑；冲突保留本地草稿并提示重新载入。编译失败保留上一份成功预览，显示源位置诊断。Monaco 提供 Typst 高亮、真实编译标记以及来自本地 TypeScript Worker 的 Valibot / valibot-form 补全和悬停；语言资源与实际类型声明随应用分发。编辑器根据分屏容器宽度自动布局和换行，续行缩进；调整面板宽度不需要刷新，也不改写源码。

### 搜索与预览

资源管理器底部的搜索条实时筛选文件和文件夹路径，保留目录层级并自动展开匹配项的父目录；匹配文件夹时显示其内容。清空或按 `Esc` 恢复完整文件树及原来的折叠状态。`Ctrl/⌘ P` 聚焦筛选，筛选仍在原文件树中完成，右键操作和报表入口保持可用。

左侧活动栏分别打开资源管理器与代码搜索；切换时保留各自的筛选和搜索内容。`Ctrl/⌘ Shift E` 打开资源管理器，`Ctrl/⌘ Shift F` 打开独立的全文搜索侧栏，在搜索侧栏按 `Esc` 返回资源管理器。代码搜索按字面匹配已保存文本，支持区分大小写；结果带行号，点击打开源码并定位。最多显示 200 项，跳过二进制和超过 2 MiB 的文本文件，并显示截断或跳过提示。侧栏隐藏时不继续请求全文搜索。

预览工具栏显示当前页和总页数，支持上一页、下一页、直接输入页码，以及可折叠的标题目录和页面列表；标题位置直接来自本次编译，滚动时同步当前页和标题。

可见的 `.typ` 编辑器与相应预览自然联动：普通单击源码定位并短暂高亮排版位置，单击预览打开对应源码并选择范围；共享 import 文件同样支持。拖动选择、键盘输入和程序定位不会反向触发。多个可见文档复用同一源文件时使用最近配对的预览，不能唯一配对时不广播。联动校验本次编译的已保存文件版本；草稿、编译中或失败时保留预览但停用过期定位。TypeScript 入口负责 schema 与数据生成，预览跳转目标由 Typst 源码 span 提供。

默认提供银行询证函、银行账户余额汇总表和季度经营分析。季度经营分析演示本地 SVG 图片、盈利公式、跨页重复表头、页眉页码和 36 行项目明细；静态图片随工作区导出，数值及明细由 schema 默认值或外部业务数据提供。

## 文件契约

默认目录：

```text
studio.json
AGENTS.md
.agents/skills/typst-authoring/SKILL.md
共享/
  主题/财务函件.typ
  字体/                         # 字体及许可证
报表/
  银行询证函/
    排版.typ
    银行询证函.ts
  银行账户余额汇总表/
    排版.typ
    银行账户余额汇总表.ts
  季度经营分析/
    季度经营分析.ts
    排版.typ
    收入结构.svg
```

`studio.json` 只声明项目名称和字体路径；字体路径相对工作区根：

```json
{
	"name": "财务报表",
	"fonts": ["共享/字体"]
}
```

没有配置文件的普通目录也可打开。Studio 按文件名发现 `目录名/目录名.ts` 报表入口，不执行代码来发现报表，也不在配置中维护文档清单。入口即使有语法错误仍保留标记，打开时报告诊断并允许编辑修复。普通 `.ts` 和 `.typ` 文件保持源码身份。错误配置会明确报告，不会默默重写。

主题直接使用正常 Typst import，例如 `#import "../../共享/主题/财务函件.typ": correspondence`。共享设计是普通源码，同工作区内任意文档可复用。字体通过配置中的目录或具体路径注册；导入自定义字体后将其目录加入配置即可。默认财务主题复用随附四种字体及许可证。没有独立的资源发布、版本固定或模板实例数据库。

同名 TypeScript 入口统一默认导出官方 `@pluxel/typst/template` 的 `defineTypstDocument({ template, schema, createFiles? })`。名称直接来自入口文件名，无需单独声明 `name`。`template` 是相对于入口目录的 `.typ` 路径，解析结果必须在工作区内；共享逻辑可从其他工作区模块导入：

```ts
import * as v from 'valibot'
import { defineTypstDocument } from '@pluxel/typst/template'

export default defineTypstDocument({
	template: './排版.typ',
	schema: v.object({
		title: v.pipe(v.optional(v.string(), '月度报表'), v.title('标题')),
		amount: v.pipe(v.optional(v.number(), 128600), v.title('金额')),
	}),
})
```

普通报表只需同名 `.ts` 入口和 `排版.typ`：schema 直接写在定义中，确有多个文档复用时才拆模块。共享主题和字体保留在 `共享/`。标题、说明使用 Valibot 的 `v.title`、`v.description`；只有专属控件配置才需要 `valibot-form` 元数据。

演示数据只来自 `v.getDefaults(schema)`，默认项目不预制 `data.json`。Studio 递归合并 schema 默认值与外部输入，保留显式用户值（包括空字符串、零和 false）；调用方数组决定长度，各已提供项递归补齐同索引默认项，空数组保持为空，再通过 `safeParse` 校验。表单与 Typst 使用同一份有效输入；新增必填字段即使导致编译失败，也会出现在表单里供用户补齐。

没有 `createFiles` 时，输入自动作为 JSON 挂载到 `/inputs/data.json`，Typst 用 `json("/inputs/data.json")` 读取。自定义 `createFiles(data)` 返回文件表，键必须位于 `/inputs/`，值为 `{ kind: 'json', value }` 或 `{ kind: 'text', text }`。数据是数据，不需要拼接成 Typst 源码。

### 在其他系统中消费模板

模板的可移植契约是 **真实源码/资产 + 外部输入 → 虚拟文件系统 → Typst**。同名 TypeScript 入口、`.typ`、共享主题、字体及许可证属于工作区；表单填写结果和业务系统查询结果属于调用方。`/inputs/` 是编译时生成的虚拟命名空间，不是应该创建在模板目录中的数据文件夹。

Studio 的表单输入保存在应用配置目录，按项目和文档入口区分。关闭重开保留填写结果，导入 ZIP 得到新的项目与 schema 默认值。`studio.json` 不声明 `data` 路径。确有静态参考数据（例如固定的标准附录）时，它是普通资产；可变的业务数据不应借此混入模板。

schema 是文档的数据契约，不限定输入来源：API、数据库、批处理和 Studio 表单都可以提供数据。外部系统不需要表单 UI；使用原生 Valibot 元数据的入口也不依赖 `valibot-form`。默认值仅适合合理缺省或演示；真实业务的关键必填字段应保持必填，缺失时报告校验错误。

外部程序推荐连接已经运行的 Studio，复用同一份求值器和原生编译会话，见下文“程序接入”。`compile({ projectId, entry, data })` 的 `data` 必填：`{}` 使用默认值，显式空字符串、0、false、null 保留其 schema 校验语义。对象递归补齐缺失键；调用方数组决定长度，各已提供项仍合并同一索引默认值，空数组保持为空。编译不读写保存的表单输入；需要保存值时先 `getInput`，再显式传 `data`。`describeDocument` 单独返回 fields/defaults，不运行 `createFiles`，非法表单值不会阻止字段继续显示。业务求值实现由 [`compiler.ts`](src/backend/compiler.ts) 和 [`documents.ts`](src/backend/documents.ts) 拥有。

## Workspace ZIP

导出工作区会压缩整个目录，包括所有真实文档文件、共享主题、字体、静态资产、AGENTS、skills 和空目录；无需选择某个文档入口。导入 ZIP 创建一个新的独立项目，不覆盖已有目录。表单填写数据、编译产物、AI 会话和供应商凭据保存在工作区外，不进入项目 ZIP。预览中的 PDF 下载仍用于输出最终文档。

限制：单文件 64 MiB、工作区 256 MiB / 5000 项、压缩归档 128 MiB。目录扫描与 ZIP 导入拒绝符号链接、硬链接及特殊文件，导入还检查重复路径、路径穿越与解压大小；失败不留下半个项目。超过限制会报错，不隐式漏掉文件。

## Pi coding agent

AI 助手默认展开为 240px 高的紧凑底部面板，点击原生工具标签可收起；底部和右侧都有原生停靠区，可拖动 AI 标签改变位置，也可拖动边界调整大小。工具可以关闭，项目菜单可重新打开。会话栏和输入区使用紧凑布局，内容宽度跟随所在面板。当前会话及未发送草稿由项目实例持有，关闭和重新打开工具仍保留；Pi 会话、已发送消息及正在进行的任务由后端持有。开发热更新可接纳布局行为属性并回收已有空组；新增边栏属于初始化结构，已有项目窗口需要重新打开项目一次。

辅助面板的“模型供应商设置”从 Pi 动态枚举支持的供应商与协议。用户可以配置 API 地址、密钥和模型 ID；已有 Pi 凭据仍可使用。公司代理预置 `https://proxy-api.nas.gxyxjt.com:10001/v1`，协议为 `openai-responses`；`deepseek-flash` 仅是建议模型 ID，未宣称代理实际提供此模型。保存配置后可调用供应商的 `/models` 发现接口（上述地址对应 `/v1/models`），或直接手动填写模型。发现列表不证明模型支持所选 API 协议。密钥不返回前端，且不对 workspace 工具开放。assistant-ui 的原生消息、composer、滚动、停止操作和 `@` 引用菜单构成辅助面板。输入 `@` 可搜索并引用工作区文件或文件夹；引用传入相应路径，agent 按需读取，不预先把整棵目录塞进上下文。

图片能力使用 Pi 模型信息和内置 [models.dev](https://models.dev/) 精简快照，按模型 ID 或显示名称精确匹配，跨供应商也尝试图片输入；用户的明确勾选优先。当前快照包含 `deepseek-flash` 的图片能力，同名公司代理模型可直接使用。模型发现接口只提供 ID 列表，不猜能力；代理是否真正接受图片由其实际响应决定。运行 `node projects/report-template-studio/scripts/update-model-image-input.mjs` 更新快照；快照记录来源、抓取时间和原始数据 SHA256，可离线使用。

Agent 的调试循环是 `compile_preview({ entry, input: { kind: 'stored' } })`（保存输入），或 `input: { kind: 'data', data: {} }`（默认值/显式数据）→ `read_preview_pages` → 修改源码 → 再编译。编译工具返回真实诊断、输入数据、版本、页数、连续相同尺寸的页面范围及目录概览。取图工具从对应成功编译的原生 document 输出 PNG，每次 1–3 页，可指定页内 pt 坐标裁剪、默认最长边 1600 像素（可设 256–2048），同时返回该页标题和源码行范围。切换查看其他页不会重编译；源码改变或另一次成功 compile 后拒绝旧版本；单独修改保存输入不会改变已显式编译的版本。图片通过 Pi 原生 image blocks 提供给模型，折叠工具 UI 仅展示页信息，避免把 base64 反复传到前端。取图无需打开预览窗口、启动浏览器或网络端口。

多页文档先通过目录选择首页、跨页表格续页和末页，再放大公式、图片和可疑分页位置；任务要求全面审查时逐批检查相关页面，不以抽样代表所有页。PNG 裁剪保留原页面背景，完整页 raster 有 8192 像素/边和 16M 像素限制，Pi adapter 根据模型最长边预算明确计算 scale，返回实际尺寸；一批 PNG 总量限制 12 MiB。外部 `renderPage` 保留所请求的 scale，超限明确失败。默认 skill 和系统提示维护这套流程；未支持图片的模型会明确得到能力提示，不声称完成视觉验证。

消息展示沿用 [browser-worker-agent](https://github.com/PluxelJS/browser-worker-agent) 的 assistant-ui 内容分组与 Streamdown 流式渲染设计：中文 Markdown、代码高亮和复制使用 `@assistant-ui/react-streamdown` 及 Streamdown 原生控件。推理和工具调用按真实 Pi 消息顺序呈现，使用传统折叠区；运行时自动展开，用户手动选择后保持其展开状态。工具标题显示名称、相关路径或命令、运行/完成/失败状态，展开后可查看参数与返回结果；错误结果同样保留。推理区只在供应商实际返回推理内容时出现，停止或失败会明确标记未完成。本地持久化记录与实时消息使用同一份 parts 契约，不把工具调用压缩成活动状态文字。外围控件继续使用 Mantine。

每个项目可以保存多个独立会话。面板顶部可以新建、搜索切换、重命名和删除会话；切换会保留本次打开项目期间的输入草稿。模型选择和供应商设置在消息输入框底部，模型按供应商分组，可搜索；每个会话会记住实际使用的模型。聊天记录保存在项目目录外，重启后仍可继续。一个项目同时只运行一个会话，以避免并发改写文件；其他会话仍可查看，输入框会提示跳回正在运行的会话。Pi 的 `cwd` 就是实际项目根。使用 SDK 的 `read` / `edit` / `write` / `ls` / `find` 工具及 Studio 的 `search_files`、`compile_preview`、`read_preview_pages`、`export_pdf`。文件工具经工作区存储边界执行，保留文件内容冲突检查，禁止越界路径；额外的 `bash` 工具使用 [just-bash](https://github.com/vercel-labs/just-bash) 模拟命令，文件操作仍经过工作区存储层；不启动系统 shell，不开放网络、JavaScript/Python 执行或自动加载可执行扩展。文本操作支持 UTF-8 源码，二进制资产不能当文本读写；目录移动/删除仍作用于真实文件。agent 可以跨文件夹修改共享主题和不同文档。命令并非事务：失败或取消前已经成功的写入仍保留；移动不会覆盖已有目标，权限与时间戳修改不受支持。执行时间与循环限制是模拟器的合作式限制，并非操作系统 CPU 沙箱。

just-bash 使用虚拟 POSIX 路径，不要求用户安装 Bash 或 WSL。这是 Windows 兼容的实现路线；上游 CI 与本项目当前桌面验证均为 Linux，尚不能宣称 Windows 整包经过实测。

新建项目附带 [AGENTS.md](workspace-assets/AGENTS.md) 和 [typst-authoring skill](workspace-assets/.agents/skills/typst-authoring/SKILL.md)，说明 schema/defaults、共享设计与编译检查。Pi 显式发现当前项目 `.agents/skills/` 中的 skills 和根 AGENTS；其他 coding agent 也能直接使用这些普通文件。技能内容随项目编辑和导出。

## 程序接入

`@report-template-studio/app/client` 导出 Node 专用 `discoverStudio`、`connectStudio`、`withStudio`，只加载 Cap’n Web、Node IPC 和协议校验。`/contracts` 是浏览器可用的类型与 `isStudioError` 判定入口；`/runtime` 导出无 Electron 的宿主级 `startBackend`；`/plugin` 保留 canonical `StudioPlugin`。类型声明和运行入口均来自实际 `dist/` 制品。

调用者显式选择实例和项目。发现不启动应用或导入项目；返回值不含凭据，连接会重新校验受保护 descriptor 与实例身份。默认发现目录为系统临时目录的 `pluxel-report-template-studio-<userKey>/instances`；应用与 client 都可显式传 `discoveryDirectory`。Linux/macOS 使用私有 Unix socket，Windows 使用当前用户权限下的 named pipe，无 TCP/HTTP 业务监听。

[`examples/inspect-report.ts`](examples/inspect-report.ts) 是可类型检查的完整导出函数，其参数提供选择来源：

```ts
import { discoverStudio, withStudio } from '@report-template-studio/app/client'

export async function inspect(selectedInstanceId: string, selectedProjectRoot: string) {
	const instances = await discoverStudio()
	const instance = instances.find((item) => item.instanceId === selectedInstanceId)
	if (!instance) throw new Error('所选实例不可用，请重新发现')
	return withStudio(instance, async (studio) => {
		const project = (await studio.listProjects()).find((item) => item.root === selectedProjectRoot)
		if (!project) throw new Error('请明确选择或打开目标项目')
		const target = { projectId: project.id, entry: '报表/季度经营分析/季度经营分析.ts' }
		const compiled = await studio.compile({ ...target, data: {} })
		const page = await studio.renderPage({
			...target,
			revision: compiled.revision,
			page: compiled.pageCount,
			scale: 2,
		})
		const pdf = await studio.exportPdf({ ...target, revision: compiled.revision })
		return { compiled, page, pdf }
	})
}
```

用返回 PNG 的绝对 `path` 调用 agent 的图片查看能力。修改普通源码后再次 compile/render；页码从 1 开始，region 是官方 Typst 页内 pt，scale 默认 2、上限 8，受完整页面原生 raster 限额约束。`withStudio` 在 finally 断开连接；长程序可使用 `connectStudio` 返回的 `{ api, disconnect }`。断连不关闭应用、求值器或原生 session，不取消已接纳的有界工作。socket 中断后写入可能已完成，client 不自动重试或切换实例。

共有方法覆盖项目 list/get/create/open/forget/tree、源码 read/write/mkdir/createReport/rename/remove/search、输入 get/set、describe/compile/renderPage/exportPdf。`writeFile` 必须提供 `expectedVersion`，创建时为 `null`。外部 ZIP/资产使用 `importWorkspaceFile` / `importAssetFile`，只为相应导入读取明确本机来源；ZIP 输出为 `exportWorkspaceFile` 的产物引用。业务 capability 不含供应商配置、模型付费调用、任意文件读取或应用关闭。

失败保持 reject。用 `isStudioError(error)` 检查 `code/message/diagnostics/issues`，不要依赖跨进程 class prototype。`INVALID_INPUT` 与字段 issues 指向数据或源码；Typst 失败保留 `COMPILE_FAILED` 与原生位置；`REVISION_CONFLICT` 要求显式重新编译；`BUSY` / `LIMIT_EXCEEDED` 明确拒绝容量不足；generation 撤回会返回 `BACKEND_UNAVAILABLE` / `CLOSED`，需重新连接。一次操作失败就停止本轮输出，不无条件继续导出。

### 无桌面常驻宿主

```ts
import { startBackend } from '@report-template-studio/app/runtime'

const backend = await startBackend({ root: absoluteStateRoot, assetsRoot: absoluteAssetsRoot })
try {
	// 这是宿主寿命：在此运行自己的长期应用，外部脚本独立发现/连接。
	await runHost(backend.api)
} finally {
	await backend.close()
}
```

`root` 是应用状态目录（workspaces/inputs/ai/artifacts），不是项目目录；`assetsRoot` 是附带 `financial-document-assets` 来源，保留原含义。同一 canonical state root 同时仅一个宿主可写，重复启动明确拒绝，不杀进程或抢占活锁。`startBackend` 等待就绪并接纳本机 IPC，`close` 停止接纳、结算工作、回收连接/文档/worker、撤销本实例发现记录。短程序只断开 client，不关闭宿主。

### 产物寿命与部署

PNG、PDF、ZIP 返回时已经完整落盘，随机 id 的独立目录原子发布，不写模板目录、不进入项目 ZIP/watcher。初始策略统一为至少保留 24 小时、总内容 512 MiB、最多 4096 个已发布文件；并发写入先预留容量。容量不足只清理已过期自有产物，不能提前删承诺文件。后续编译、session 淘汰、forget、正常关闭/重启和 Backend HMR 不覆盖或提前删除产物。应用启动恢复 metadata 与完整文件并清理自有未完成目录；到 expiresAt 后不保证可读，需要长期保留时复制到自己的输出目录。

应用与 client 必须共享本机文件系统。Flatpak/容器隔离时显式指定双方可访问的 discoveryDirectory，并验证返回产物在 agent 运行环境可读；仅能连接而不能读取 path 不构成接入成功。外部删除 profile、磁盘损坏不属于保留保证。

## 通信与执行

```text
renderer → Cap’n Web / structured-clone MessagePort → narrow Desktop capability ─┐
Node client → authenticated Cap’n Web / local socket → narrow Studio capability ┼→ StudioPlugin
Pi tools → direct business methods ─────────────────────────────────────────────┘
  → WorkspaceStore / InputStore → DocumentService → TemplateCompiler + TypstSession + ArtifactStore
```

Electron 主进程只校验 window/frame/origin、转交 port 并拥有系统对话框。向量按需通过 `getPreview` 的 Uint8Array 进入原有 WASM/SVG renderer，无文本编码或转移后端缓存 buffer。PDF 保存只传 artifact id，由受信任主进程 capability 校验并复制；renderer 不能指定任意绝对来源。开发后端由 [`dev.ts`](src/backend/dev.ts) 使用官方 host-vite 装配 [`application.ts`](src/backend/application.ts)，撤回旧 generation 会使连接失败；不自动重放。renderer 保留 context isolation、sandbox、CSP 和关闭保护。Pi 的受信任 adapter 按 id 读取 PNG 并生成模型 image content；普通 read/bash 仍限定模板工作区。

报表执行使用独立的 Vite `DevEnvironment`、模块图与官方 `ModuleRunner`，通过进程内 HMR channel 传递更新，不启动 HTTP/WebSocket listener。工作区源文件快照是每次编译的权威输入，源码差异通过 `reloadModule` 传播；外部文件编辑和 Studio 保存走同一条热更新路径。共享 `.typ` 也进入依赖图。

每个活跃文档入口拥有独立 QuickJS WASM 运行环境，最多四个；允许 workspace 内 TypeScript 模块与 `valibot` / `valibot-form`，无 Node、网络和主机文件访问。64 MiB 堆、1.5 秒执行片段中断与 10 秒异步期限限制失控代码。Rolldown 仅预打包固定运行时依赖；项目代码转换和 HMR 由 Vite 管理。

增量分为两层：Vite 保留报表入口及依赖的模块图与热更新状态；官方 Typst 文档会话保留专用 worker 内的原生编译器及缓存。`session.update({ files, template? })` 全量替换本次输入；可选 `template` 替换源码快照，worker 对比虚拟文件内容，仅更新变更或删除的 shadow 文件。编译错误保留上次成功预览，修正后继续使用会话。

Studio 最多保留四个活跃文档会话。仅修改表单输入时复用模板快照，不重复复制整个工作区或读取所有字体；源码版本变化才更新快照。字体内容变化会重建相应文档会话，让原生字体缓存失效。移除项目记录、会话淘汰或应用关闭会释放对应资源。每次成功 compile 产生唯一公开 revision，并映射真实 native session/revision。只保留当前原生 document；输出逐项校验 revision 与源码版本，竞争明确报错。已经发布的磁盘产物是独立不可变证据。此应用层执行隔离不等同于原生 Typst 的操作系统沙箱。

## 验证

```sh
pnpm --filter @report-template-studio/app build
pnpm --filter @report-template-studio/app typecheck
pnpm --filter @report-template-studio/app test
pnpm --filter @report-template-studio/app test:runtime
pnpm --filter @report-template-studio/app test:desktop
```

首次检查先 build，公开入口的类型来自实际 `dist/` 声明。此次常驻服务重构的实施位置、消费者迁移、真实边界证据及未验证项见 [实施报告](IMPLEMENTATION_REPORT.md)。

测试覆盖真实目录、外部改动与并发冲突、ZIP 往返和失败清理、默认值合并、跨目录 Vite HMR、运行器限制、官方 Typst/PDF、Pi 真实文件工具与会话生命周期。生产 `test:runtime` 在导入运行入口前禁止 TCP/HTTP `net.Server.listen`，仅允许本机 IPC。它从构建后的公开 client export 在另一个 Node 进程发现、认证、编译并读取 PNG/PDF，验证重连、原生源码定位及真实多页标题目录。默认使用当前项目 `dist/`；设置 `STUDIO_APP_ROOT` 为发布目录中的 `resources/app` 可执行同一检查，使用发布包自己的依赖、字体、原生库和 QuickJS。Windows Action 只在打包后执行这一生产检查。

桌面验收使用隔离 profile 和真实 Electron preload/IPC，只将系统文件选择器替换为指定临时路径；需要桌面显示环境，结果在 `test-results/`。`STUDIO_EXECUTABLE` 可指向独立包执行同一套验收。受限容器中若 Electron 系统沙箱无法启动，可显式设置 `STUDIO_DISABLE_SANDBOX=1`；该变量仅由测试脚本读取，不改变产品 renderer sandbox 配置。

未使用付费模型执行真实供应商生成；已有 AI 工具、技能、引用与无凭据状态测试不能代替该边界的验证。
