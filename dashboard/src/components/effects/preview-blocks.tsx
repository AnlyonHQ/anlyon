import { IdValue } from "@/components/actions/detail-sheet";
import {
	TONE_PILL,
	TONE_SURFACE,
	type Tone,
} from "@/components/approvals/tone";
import {
	Accordion,
	AccordionItem,
	AccordionPanel,
	AccordionTrigger,
} from "@/components/ui/accordion";
import type { ActionPreview, ImpactQuantity, PreviewBlock } from "@/lib/types";
import { cn } from "@/lib/utils";

const LIMITATION_LABEL: Record<
	"guarantee" | "freshness" | "unsupported" | "irreversible",
	string
> = {
	guarantee: "Supported",
	freshness: "Not protected",
	unsupported: "Not supported",
	irreversible: "Irreversible",
};

const LIMITATION_TONE: Record<keyof typeof LIMITATION_LABEL, Tone> = {
	guarantee: "emerald",
	freshness: "amber",
	unsupported: "neutral",
	irreversible: "rose",
};

type LimitationKind = keyof typeof LIMITATION_LABEL;

export function splitLimitation(
	kind: LimitationKind,
	text: string,
): { title: string; detail: string | null } {
	const colon = text.indexOf(": ");
	if (colon <= 0 || colon > 80) return { title: text, detail: null };
	const head = text.slice(0, colon).trim();
	const rest = text.slice(colon + 2).trim();
	if (head.toLowerCase() === LIMITATION_LABEL[kind].toLowerCase()) {
		return { title: rest, detail: null };
	}
	return {
		title: head,
		detail: rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : null,
	};
}

function LimitationBadge({ kind }: { kind: LimitationKind }) {
	return (
		<span
			className={cn(
				"inline-flex w-[6.75rem] shrink-0 justify-center rounded px-1.5 py-0.5 font-medium text-[10.5px] uppercase tracking-wide",
				TONE_PILL[LIMITATION_TONE[kind]],
			)}
		>
			{LIMITATION_LABEL[kind]}
		</span>
	);
}

function Limitations({
	items,
}: {
	items: { kind: LimitationKind; text: string }[];
}) {
	return (
		<Accordion
			className="overflow-hidden rounded-lg border border-border/70"
			multiple
		>
			{items.map((item) => {
				const { title, detail } = splitLimitation(item.kind, item.text);
				if (!detail) {
					return (
						<div
							className="flex items-start gap-3 border-b px-3.5 py-3 text-sm last:border-b-0"
							key={item.text}
						>
							<LimitationBadge kind={item.kind} />
							<span className="min-w-0">{title}</span>
						</div>
					);
				}
				return (
					<AccordionItem key={item.text} value={item.text}>
						<AccordionTrigger className="items-start gap-3 rounded-none px-3.5 py-3 font-normal hover:bg-muted/40">
							<LimitationBadge kind={item.kind} />
							<span className="min-w-0 flex-1">{title}</span>
						</AccordionTrigger>
						<AccordionPanel className="pr-10 pb-3.5 pl-[calc(0.875rem+6.75rem+0.75rem)] leading-relaxed">
							{detail}
						</AccordionPanel>
					</AccordionItem>
				);
			})}
		</Accordion>
	);
}

export function formatQuantity(q: ImpactQuantity): string {
	const bound = q.bound === "upper_bound" ? "up to " : "";
	if (q.dimension === "money") {
		return `${bound}${(q.amount / 100).toFixed(2)} ${(q.currency ?? "").toUpperCase()}`.trim();
	}
	if (q.dimension === "resource_mutations") {
		return `${bound}${q.amount} resource change${q.amount === 1 ? "" : "s"}`;
	}
	return `${bound}${q.amount} ${q.dimension}`;
}

export function EnvironmentBanner({
	environment,
}: {
	environment: ActionPreview["environment"];
}) {
	const production = environment.kind === "production";
	return (
		<p
			className={cn(
				"rounded-lg border px-3 py-2 font-medium text-sm",
				TONE_SURFACE[production ? "rose" : "neutral"],
			)}
			data-testid="preview-environment"
		>
			Executes in <span className="font-semibold">{environment.name}</span> (
			{environment.kind}
			{production ? ", a production environment" : ""})
		</p>
	);
}

function Block({ block, index }: { block: PreviewBlock; index: number }) {
	const headingId = `preview-block-${index}`;
	switch (block.type) {
		case "fields":
			return (
				<section aria-labelledby={headingId} className="space-y-2">
					<h4 className="font-medium text-sm" id={headingId}>
						{block.title}
					</h4>
					<dl className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
						{block.fields.map((field) => (
							<div
								className="grid gap-1 px-3.5 py-2.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4"
								key={field.label}
							>
								<dt className="text-muted-foreground text-xs leading-5">
									{field.label}
								</dt>
								<dd className="break-words font-mono text-xs leading-5">
									{field.value}
								</dd>
							</div>
						))}
					</dl>
				</section>
			);
		case "text_diff":
			return (
				<section aria-labelledby={headingId} className="space-y-2">
					<h4 className="font-medium text-sm" id={headingId}>
						{block.title}: <span className="font-mono">{block.path}</span>
					</h4>
					<div className="grid gap-2 md:grid-cols-2">
						{(["before", "after"] as const).map((side) => (
							<figure className="min-w-0 space-y-1" key={side}>
								<figcaption className="text-muted-foreground text-xs">
									{side === "before"
										? "Current content"
										: "Content after the change"}
								</figcaption>
								<section
									aria-label={`${side === "before" ? "Current" : "New"} content of ${block.path}`}
									className="max-h-64 overflow-auto rounded-lg border border-border/60 bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
									// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable to scroll by keyboard.
									tabIndex={0}
								>
									<pre className="p-3 font-mono text-xs leading-relaxed">
										{block[side] || "(empty)"}
									</pre>
								</section>
							</figure>
						))}
					</div>
					{block.truncated ? (
						<p className="text-muted-foreground text-xs">
							Shown truncated. The full request is in the effect's request.
						</p>
					) : null}
				</section>
			);
		case "impact":
			return (
				<section aria-labelledby={headingId} className="space-y-2">
					<h4 className="font-medium text-sm" id={headingId}>
						Expected impact
					</h4>
					<ul className="flex flex-wrap gap-2">
						{block.quantities.map((q) => (
							<li
								className="rounded-lg border border-border/70 px-3 py-1.5 font-medium text-sm tabular-nums"
								key={`${q.dimension}-${q.currency ?? ""}`}
							>
								{formatQuantity(q)}
							</li>
						))}
					</ul>
				</section>
			);
		case "limitations":
			return (
				<section aria-labelledby={headingId} className="space-y-2">
					<h4 className="font-medium text-sm" id={headingId}>
						{block.title}
					</h4>
					<Limitations items={block.items} />
				</section>
			);
		default:
			return null;
	}
}

export function PreviewBlocks({ preview }: { preview: ActionPreview }) {
	const expired = new Date(preview.expiresAt).getTime() <= Date.now();
	return (
		<div className="space-y-6" data-testid="effect-preview">
			<EnvironmentBanner environment={preview.environment} />
			{expired ? (
				<output className="block text-destructive text-sm">
					This preview expired at {new Date(preview.expiresAt).toLocaleString()}
					. It can no longer execute. A new preview and approval are required.
				</output>
			) : null}
			{preview.blocks.map((block, index) => (
				<Block
					block={block}
					index={index}
					// biome-ignore lint/suspicious/noArrayIndexKey: immutable, ordered blocks.
					key={index}
				/>
			))}
			{preview.allowances.length > 0 ? (
				<section
					aria-label="Impact limits at review time"
					className="space-y-2"
				>
					<h4 className="font-medium text-sm">Impact limits at review time</h4>
					<ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70 text-sm">
						{preview.allowances.map((a) => (
							<li className="px-3.5 py-2.5" key={String(a.limitId ?? a.reason)}>
								{a.blocked
									? `Blocked: ${String(a.message)}`
									: `${String(a.name)}: needs ${String(a.requested)}, ${String(a.available)} available${a.sufficient ? "" : " (not enough)"}`}
							</li>
						))}
					</ul>
					<p className="text-muted-foreground text-xs">
						Rechecked immediately before dispatch.
					</p>
				</section>
			) : null}
			<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
				<span>Binding {preview.bindingDigest.slice(0, 16)}…</span>
				<span aria-hidden="true">·</span>
				<span>preview</span>
				<IdValue label="preview id" value={preview.id} />
			</p>
		</div>
	);
}
