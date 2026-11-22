import {
	autocompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
} from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";
import type { CodeEditorProps } from "./code-editor";

const theme = EditorView.theme({
	"&": {
		backgroundColor: "transparent",
		color: "var(--foreground)",
		fontSize: "13px",
		height: "100%",
	},
	".cm-scroller": {
		fontFamily: "var(--font-mono)",
		lineHeight: "1.7",
	},
	".cm-content": { caretColor: "var(--foreground)", padding: "14px 0" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
	"&.cm-focused": { outline: "none" },
	".cm-gutters": {
		backgroundColor: "transparent",
		color: "color-mix(in oklab, var(--muted-foreground) 70%, transparent)",
		border: "none",
		paddingLeft: "6px",
	},
	".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 8px" },
	".cm-activeLine": {
		backgroundColor: "color-mix(in oklab, var(--muted) 55%, transparent)",
	},
	".cm-activeLineGutter": {
		backgroundColor: "transparent",
		color: "var(--foreground)",
	},
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
		{
			backgroundColor:
				"color-mix(in oklab, var(--cm-selection) 26%, transparent) !important",
		},
	".cm-matchingBracket": {
		backgroundColor:
			"color-mix(in oklab, var(--cm-selection) 18%, transparent)",
		outline: "none",
	},
	".cm-foldPlaceholder": {
		backgroundColor: "var(--muted)",
		border: "none",
		color: "var(--muted-foreground)",
	},
	".cm-tooltip": {
		border: "1px solid var(--border)",
		backgroundColor: "var(--popover)",
		color: "var(--foreground)",
		borderRadius: "8px",
		overflow: "hidden",
		boxShadow: "0 8px 24px -12px rgb(0 0 0 / 0.25)",
	},
	".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-mono)" },
	".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px" },
	".cm-tooltip-autocomplete > ul > li[aria-selected]": {
		backgroundColor: "var(--accent)",
		color: "var(--foreground)",
	},
	".cm-completionDetail": {
		color: "var(--muted-foreground)",
		fontStyle: "normal",
		marginLeft: "12px",
	},
	".cm-placeholder": { color: "var(--muted-foreground)" },
});

const highlight = HighlightStyle.define([
	{
		tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword],
		color: "var(--cm-keyword)",
	},
	{
		tag: [t.string, t.special(t.string), t.regexp],
		color: "var(--cm-string)",
	},
	{
		tag: [t.number, t.bool, t.null, t.atom],
		color: "var(--cm-number)",
	},
	{
		tag: [t.function(t.variableName), t.function(t.propertyName)],
		color: "var(--cm-function)",
	},
	{
		tag: [t.propertyName, t.attributeName],
		color: "var(--cm-property)",
	},
	{
		tag: [t.comment, t.lineComment, t.blockComment],
		color: "var(--cm-comment)",
		fontStyle: "italic",
	},
	{ tag: [t.typeName, t.className], color: "var(--cm-type)" },
	{ tag: [t.definition(t.variableName)], color: "var(--foreground)" },
	{ tag: [t.punctuation, t.bracket], color: "var(--muted-foreground)" },
]);

function actionNameSource(actions: CodeEditorProps["actions"]) {
	return (context: CompletionContext): CompletionResult | null => {
		if (!actions || actions.length === 0) return null;
		const before = context.matchBefore(
			/anlyon\.(?:invoke|read)\(\s*["'`][\w-]*/,
		);
		if (!before) return null;
		const quote = before.text.search(/["'`]/);
		const kind = before.text.includes(".read(") ? "read" : "invoke";
		const options: Completion[] = actions
			.filter((action) => kind === "invoke" || action.method === "GET")
			.map((action) => ({
				label: action.name,
				detail: action.method === "GET" ? "read" : `write · ${action.method}`,
				info: action.description ?? undefined,
				type: action.method === "GET" ? "function" : "method",
			}));
		return {
			from: before.from + quote + 1,
			options,
			validFor: /^[\w-]*$/,
		};
	};
}

export default function CodeEditorImpl({
	value,
	onChange,
	language,
	readOnly = false,
	actions,
	onSave,
	onRun,
	onReady,
	label,
	placeholder,
	className,
	minHeight,
}: CodeEditorProps) {
	const handlers = useRef({ onSave, onRun });
	useEffect(() => {
		handlers.current = { onSave, onRun };
	});
	const extensions = useMemo(() => {
		const lang =
			language === "python"
				? python()
				: language === "json"
					? json()
					: javascript();
		return [
			lang,
			theme,
			syntaxHighlighting(highlight),
			EditorView.lineWrapping,
			EditorView.contentAttributes.of({
				"aria-label": label,
				spellcheck: "false",
				autocapitalize: "off",
				autocorrect: "off",
			}),
			autocompletion({
				override: language === "json" ? [] : [actionNameSource(actions)],
				icons: false,
			}),
			Prec.highest(
				keymap.of([
					{
						key: "Mod-s",
						preventDefault: true,
						run: () => {
							handlers.current.onSave?.();
							return true;
						},
					},
					{
						key: "Mod-Enter",
						preventDefault: true,
						run: () => {
							handlers.current.onRun?.();
							return true;
						},
					},
				]),
			),
		];
	}, [language, actions, label]);

	return (
		<CodeMirror
			basicSetup={{
				foldGutter: language !== "json",
				highlightActiveLine: !readOnly,
				highlightActiveLineGutter: !readOnly,
				autocompletion: false,
				searchKeymap: true,
				tabSize: language === "python" ? 4 : 2,
			}}
			className={className}
			editable={!readOnly}
			extensions={extensions}
			height="100%"
			indentWithTab
			minHeight={minHeight}
			onChange={onChange}
			onCreateEditor={(view) => onReady?.(view)}
			placeholder={placeholder}
			readOnly={readOnly}
			theme="none"
			value={value}
		/>
	);
}
