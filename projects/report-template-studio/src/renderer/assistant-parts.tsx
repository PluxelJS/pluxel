import {
	createContext,
	memo,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { Collapse, Loader, Text, UnstyledButton } from '@mantine/core'
import {
	MessagePrimitive,
	groupPartByType,
	useAuiState,
	useScrollLock,
	type ToolCallMessagePartProps,
} from '@assistant-ui/react'
import { StreamdownTextPrimitive, type SecurityConfig } from '@assistant-ui/react-streamdown'
import { code } from '@streamdown/code'
import { cjk } from '@streamdown/cjk'
import {
	CodeBlock,
	CodeBlockCopyButton,
	Streamdown,
	useIsCodeFenceIncomplete,
	type BlockProps,
	type CodeHighlighterPlugin,
	type StreamdownProps,
} from 'streamdown'
import { IconBrain, IconCheck, IconChevronDown, IconTool, IconX } from '@tabler/icons-react'
import 'streamdown/styles.css'

// Large file reads should stay cheap while retaining exact, copyable output.
const nativeCode: CodeHighlighterPlugin = code
const boundedCode: CodeHighlighterPlugin = {
	...nativeCode,
	highlight(options, callback) {
		if (options.code.length > 8_000) {
			return {
				bg: 'transparent',
				fg: 'inherit',
				tokens: [[{ content: options.code, color: 'inherit' }]],
			}
		}
		return nativeCode.highlight(options, callback)
	},
}
const displayProps = {
	plugins: { code: boundedCode, cjk },
	translations: {
		copyCode: '复制代码',
		copied: '已复制',
		imageNotAvailable: '图片无法加载',
	},
	controls: false,
	codeBlockMaxHeight: '24rem',
	lineNumbers: false,
	linkSafety: { enabled: false },
	remarkRehypeOptions: { allowDangerousHtml: false },
	skipHtml: true,
} satisfies StreamdownProps
const security: SecurityConfig = {
	allowedProtocols: ['http:', 'https:', 'mailto:'],
	allowDataImages: false,
	defaultOrigin: globalThis.location?.origin,
}
const markdownComponents = { SyntaxHighlighter: NativeCodeBlock }

/** Native assistant-ui part state drives Streamdown's streaming and deferred rendering. */
function MarkdownText() {
	return (
		<StreamdownTextPrimitive
			{...displayProps}
			components={markdownComponents}
			containerClassName="studio-assistant-markdown"
			security={security}
			defer
		/>
	)
}

const LanguageContext = createContext('text')
const literalCodeBlock = (source: string) => [source]
function NativeCodeBlock({ code: source, language }: { code?: unknown; language?: unknown }) {
	const incomplete = useIsCodeFenceIncomplete()
	// The adapter's component registry accepts generic Markdown props as well as
	// its typed code-fence slot; only render an actual code-fence payload.
	if (typeof source !== 'string' || typeof language !== 'string') return null
	return (
		<CodeBlock code={source} language={language} lineNumbers={false} isIncomplete={incomplete}>
			<CodeBlockCopyButton />
		</CodeBlock>
	)
}
function ReadOnlyCodeBlock({ content }: BlockProps) {
	const language = useContext(LanguageContext)
	return <NativeCodeBlock code={content} language={language} />
}
const ToolCode = memo(function ToolCode({
	value,
	language = 'text',
}: {
	value: string
	language?: string
}) {
	return (
		<LanguageContext value={language}>
			<Streamdown
				{...displayProps}
				className="studio-tool-code"
				parseMarkdownIntoBlocksFn={literalCodeBlock}
				BlockComponent={ReadOnlyCodeBlock}
				parseIncompleteMarkdown={false}
				isAnimating={false}
			>
				{value}
			</Streamdown>
		</LanguageContext>
	)
})

/** A conventional disclosure: running content opens until the reader chooses its state. */
function Disclosure({
	label,
	icon,
	running = false,
	error = false,
	className = '',
	children,
}: {
	label: ReactNode
	icon?: ReactNode
	running?: boolean
	error?: boolean
	className?: string
	children: ReactNode
}) {
	const id = useId()
	const root = useRef<HTMLDivElement>(null)
	const lockScroll = useScrollLock(root, 200)
	const [manualOpen, setManualOpen] = useState<boolean | null>(null)
	const open = manualOpen ?? running
	return (
		<div
			className={`studio-assistant-disclosure ${className}`}
			data-error={error || undefined}
			ref={root}
		>
			<UnstyledButton
				className="studio-assistant-disclosure-trigger"
				aria-expanded={open}
				aria-controls={id}
				aria-busy={running || undefined}
				onClick={() => {
					lockScroll()
					setManualOpen(!open)
				}}
			>
				<IconChevronDown
					size={15}
					aria-hidden
					className="studio-disclosure-chevron"
					data-open={open || undefined}
				/>
				{running ? <Loader size={14} aria-hidden /> : icon}
				<span className="studio-disclosure-label">{label}</span>
			</UnstyledButton>
			<Collapse expanded={open} transitionDuration={200} id={id}>
				<div className="studio-assistant-disclosure-body">{children}</div>
			</Collapse>
		</div>
	)
}

function Reasoning({ running, children }: { running: boolean; children: ReactNode }) {
	const viewport = useRef<HTMLDivElement>(null)
	const content = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!running || !viewport.current || !content.current) return
		const element = viewport.current
		let following = true
		let lastTop = element.scrollTop
		const onScroll = () => {
			if (element.scrollTop < lastTop) following = false
			else if (element.scrollHeight - element.scrollTop - element.clientHeight < 2) following = true
			lastTop = element.scrollTop
		}
		const follow = () => {
			if (following) {
				element.scrollTop = element.scrollHeight
				lastTop = element.scrollTop
			}
		}
		const observer = new ResizeObserver(follow)
		observer.observe(content.current)
		element.addEventListener('scroll', onScroll)
		follow()
		return () => {
			observer.disconnect()
			element.removeEventListener('scroll', onScroll)
		}
	}, [running])
	return (
		<Disclosure
			label={running ? '正在思考' : '思考过程'}
			icon={<IconBrain size={15} aria-hidden />}
			running={running}
			className="studio-assistant-reasoning"
		>
			<div className="studio-reasoning-scroll" ref={viewport}>
				<div ref={content}>{children}</div>
			</div>
		</Disclosure>
	)
}

const toolLabels: Record<string, string> = {
	read: '读取文件',
	write: '写入文件',
	edit: '修改文件',
	ls: '列出目录',
	find: '查找文件',
	search_files: '搜索工作区',
	compile_preview: '编译预览',
	bash: '运行工作区命令',
}
function ToolCall({
	toolName,
	toolCallId,
	args,
	argsText,
	result,
	isError,
	status,
}: ToolCallMessagePartProps) {
	const state = useAuiState((s) => {
		const states = s.message.metadata.custom.toolStates as Record<string, unknown> | undefined
		return states?.[toolCallId]
	})
	const running =
		state === 'running' ||
		(state === undefined && status.type === 'running' && result === undefined)
	const failed = state === 'error' || Boolean(isError)
	const finished = state === 'complete' || result !== undefined
	const detail = [args?.path, args?.entry, args?.command, args?.query, args?.pattern].find(
		(value) => typeof value === 'string',
	)
	const title = toolLabels[toolName] ?? toolName
	return (
		<Disclosure
			label={
				<>
					<span>{title}</span>
					{detail && <span className="studio-tool-detail">{String(detail)}</span>}
					<span className="studio-tool-status">
						{running ? '运行中' : failed ? '失败' : finished ? '完成' : '未完成'}
					</span>
				</>
			}
			icon={
				failed ? (
					<IconX size={15} aria-hidden />
				) : finished ? (
					<IconCheck size={15} aria-hidden />
				) : (
					<IconTool size={15} aria-hidden />
				)
			}
			running={running}
			error={failed}
			className="studio-assistant-tool"
		>
			<Text size="xs" c="dimmed" mb={4}>
				参数
			</Text>
			<ToolCode
				value={running ? argsText || JSON.stringify(args, null, 2) : JSON.stringify(args, null, 2)}
				language="json"
			/>
			{result !== undefined && (
				<>
					<Text size="xs" c={failed ? 'red' : 'dimmed'} mt="xs" mb={4}>
						{failed ? '错误' : '返回结果'}
					</Text>
					<ToolCode
						value={typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
						language={typeof result === 'string' ? 'text' : 'json'}
					/>
				</>
			)}
			{!running && result === undefined && (
				<Text size="xs" c="dimmed" mt="xs">
					此次调用未返回结果。
				</Text>
			)}
		</Disclosure>
	)
}

const groupBy = groupPartByType({
	reasoning: ['group-reasoning'],
	'tool-call': ['group-tools'],
})
export function AssistantParts() {
	const messageStatus = useAuiState((s) => s.message.status)
	return (
		<>
			<MessagePrimitive.GroupedParts groupBy={groupBy} indicator="no-text">
				{({ part, children }) => {
					switch (part.type) {
						case 'group-reasoning':
							return <Reasoning running={part.status.type === 'running'}>{children}</Reasoning>
						case 'group-tools':
							return <div className="studio-assistant-tools">{children}</div>
						case 'text':
						case 'reasoning':
							return <MarkdownText />
						case 'tool-call':
							return part.toolUI ?? <ToolCall {...part} />
						case 'indicator':
							return (
								<div className="studio-assistant-generating" role="status">
									<Loader size={14} />
									<span>正在生成…</span>
								</div>
							)
						default:
							return null
					}
				}}
			</MessagePrimitive.GroupedParts>
			{messageStatus?.type === 'incomplete' && (
				<Text
					size="xs"
					c={messageStatus.reason === 'error' ? 'red' : 'dimmed'}
					mt="xs"
					role="status"
				>
					{messageStatus.reason === 'cancelled'
						? '本轮已停止。'
						: messageStatus.reason === 'error'
							? '本轮处理失败。'
							: '本轮尚未完成。'}
				</Text>
			)}
		</>
	)
}
