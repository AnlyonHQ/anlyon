import type { EditorView } from "@codemirror/view";
import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";

export interface CodeEditorProps {
	value: string;
	onChange: (value: string) => void;
	language: "javascript" | "python" | "json";
	readOnly?: boolean;
	actions?: Array<{
		name: string;
		method: string;
		description?: string | null;
	}>;
	onSave?: () => void;
	onRun?: () => void;
	onReady?: (view: EditorView) => void;
	label: string;
	placeholder?: string;
	className?: string;
	minHeight?: string;
}

const CodeEditorImpl = lazy(() => import("./code-editor-impl"));

export function CodeEditor(props: CodeEditorProps) {
	return (
		<div
			className={cn(
				"relative h-full min-h-0",
				"[--cm-comment:#6e7781] [--cm-function:#8250df] [--cm-keyword:#cf222e] [--cm-number:#0550ae] [--cm-property:#0550ae] [--cm-selection:#0969da] [--cm-string:#0a3069] [--cm-type:#953800]",
				"dark:[--cm-comment:#8b949e] dark:[--cm-function:#d2a8ff] dark:[--cm-keyword:#ff7b72] dark:[--cm-number:#79c0ff] dark:[--cm-property:#79c0ff] dark:[--cm-selection:#58a6ff] dark:[--cm-string:#a5d6ff] dark:[--cm-type:#ffa657]",
				props.className,
			)}
		>
			<Suspense fallback={<FallbackEditor {...props} />}>
				<CodeEditorImpl {...props} className="h-full" />
			</Suspense>
		</div>
	);
}

function FallbackEditor({
	value,
	onChange,
	readOnly,
	label,
	placeholder,
	minHeight,
}: CodeEditorProps) {
	return (
		<textarea
			aria-label={label}
			autoCapitalize="none"
			autoComplete="off"
			autoCorrect="off"
			className="block h-full w-full resize-none bg-transparent px-4 py-3.5 font-mono text-[13px] text-foreground leading-[1.7] outline-none"
			onChange={(event) => onChange(event.target.value)}
			placeholder={placeholder}
			readOnly={readOnly}
			spellCheck={false}
			style={minHeight ? { minHeight } : undefined}
			value={value}
		/>
	);
}
