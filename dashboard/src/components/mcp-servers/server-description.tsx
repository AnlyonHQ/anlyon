import { useState } from "react";
import type { ToolInput } from "@/lib/mcp-servers";
import { cn } from "@/lib/utils";

type Block =
	| { kind: "text"; lines: string[] }
	| { kind: "list"; ordered: boolean; items: string[] };

const LIST_ITEM = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/;

export function blocksOf(text: string): Block[] {
	const blocks: Block[] = [];
	for (const chunk of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
		let current: Block | null = null;
		for (const raw of chunk.split("\n")) {
			const line = raw.trimEnd();
			if (!line.trim()) continue;
			const item = LIST_ITEM.exec(line);
			if (item) {
				const ordered = item[2] !== undefined;
				if (current?.kind !== "list" || current.ordered !== ordered) {
					current = { kind: "list", ordered, items: [] };
					blocks.push(current);
				}
				current.items.push(item[3] ?? "");
			} else {
				if (current?.kind !== "text") {
					current = { kind: "text", lines: [] };
					blocks.push(current);
				}
				current.lines.push(line.trim());
			}
		}
	}
	return blocks;
}

function plain(text: string): string {
	return text.replace(/\*\*|__/g, "").replace(/^#{1,6}\s+/, "");
}

function Inline({ text }: { text: string }) {
	const parts = text.split(/(`[^`\n]+`)/g);
	return (
		<>
			{parts.map((part, i) =>
				part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
					<code
						className="rounded-[4px] bg-muted px-1 py-px font-mono text-[0.92em]"
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line never reorder
						key={i}
						translate="no"
					>
						{part.slice(1, -1)}
					</code>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line never reorder
					<span key={i}>{plain(part)}</span>
				),
			)}
		</>
	);
}

export function summaryOf(text: string | null | undefined, max = 160): string {
	const first = blocksOf(text ?? "")[0];
	if (!first) return "";
	const line = plain(
		(first.kind === "text"
			? first.lines.join(" ")
			: (first.items[0] ?? "")
		).replace(/`([^`\n]+)`/g, "$1"),
	);
	const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
	return sentence.length > max
		? `${sentence.slice(0, max - 1).trimEnd()}…`
		: sentence;
}

function BlockView({ block }: { block: Block }) {
	if (block.kind === "list") {
		const List = block.ordered ? "ol" : "ul";
		return (
			<List
				className={cn(
					"space-y-0.5 ps-4",
					block.ordered ? "list-decimal" : "list-disc",
				)}
			>
				{block.items.map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a description's items never reorder
					<li key={i}>
						<Inline text={item} />
					</li>
				))}
			</List>
		);
	}
	return (
		<p className="break-words">
			{block.lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a description's lines never reorder
				<span className="block" key={i}>
					<Inline text={line} />
				</span>
			))}
		</p>
	);
}

const SHORT = 280;

export function ServerDescription({
	text,
	label,
	empty = "The server gives no description.",
}: {
	text: string;
	label: string;
	empty?: string;
}) {
	const [open, setOpen] = useState(false);
	const blocks = blocksOf(text);
	const first = blocks[0];
	const firstLength =
		first?.kind === "text"
			? first.lines.join(" ").length
			: (first?.items.join(" ").length ?? 0);
	const long = blocks.length > 1 || firstLength > SHORT;
	const words = text.split(/\s+/).filter(Boolean).length;

	return (
		<div className="min-w-0">
			<p className="mb-1.5 text-muted-foreground text-xs">{label}</p>
			<div className="border-border border-l-2 ps-3 text-[13px] text-foreground/85 leading-relaxed">
				{!first ? (
					<p className="text-muted-foreground">{empty}</p>
				) : open || !long ? (
					<div className="max-h-96 space-y-2 overflow-y-auto pe-1">
						{blocks.map((block, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: a description's blocks never reorder
							<BlockView block={block} key={i} />
						))}
					</div>
				) : (
					<div className="line-clamp-3">
						<BlockView block={first} />
					</div>
				)}
			</div>
			{long ? (
				<button
					className="mt-1.5 ms-3 rounded-sm text-muted-foreground text-xs underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => setOpen(!open)}
					type="button"
				>
					{open ? "Show less" : `Read all of it (${words} words)`}
				</button>
			) : null}
		</div>
	);
}

const FIRST_INPUTS = 6;

export function ToolInputList({
	inputs,
	label,
}: {
	inputs: ToolInput[];
	label: string;
}) {
	const [all, setAll] = useState(false);
	const sorted = [...inputs].sort(
		(a, b) => Number(b.required) - Number(a.required),
	);
	const shown = all ? sorted : sorted.slice(0, FIRST_INPUTS);
	return (
		<div className="min-w-0">
			<p className="mb-1.5 text-muted-foreground text-xs">
				{label} · {inputs.length}
				{inputs.some((input) => input.required)
					? `, ${inputs.filter((input) => input.required).length} required`
					: ""}
			</p>
			<ul className="divide-y rounded-md border text-xs">
				{shown.map((input) => (
					<li className="grid gap-0.5 px-2.5 py-1.5" key={input.name}>
						<span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
							<code className="font-medium font-mono" translate="no">
								{input.name}
							</code>
							<span className="text-muted-foreground">{input.type}</span>
							{input.required ? (
								<span className="text-warning-foreground">required</span>
							) : null}
						</span>
						{input.description ? (
							<span
								className="line-clamp-2 break-words text-muted-foreground"
								title={input.description}
							>
								<Inline text={input.description} />
							</span>
						) : null}
					</li>
				))}
			</ul>
			{sorted.length > FIRST_INPUTS ? (
				<button
					className="mt-1.5 rounded-sm text-muted-foreground text-xs underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
					onClick={() => setAll(!all)}
					type="button"
				>
					{all ? "Show fewer" : `Show all ${sorted.length} inputs`}
				</button>
			) : null}
		</div>
	);
}
