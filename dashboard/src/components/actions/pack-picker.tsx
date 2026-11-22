import { Check, Search, Workflow } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { IntegrationLogo } from "@/components/actions/integration-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cataloguePack, type PackManifest } from "@/lib/packs";
import { cn } from "@/lib/utils";

const NAMES: Record<string, string> = {
	calcom: "Cal.com",
	clickup: "ClickUp",
	github: "GitHub",
	gitlab: "GitLab",
	hubspot: "HubSpot",
	pagerduty: "PagerDuty",
	sendgrid: "SendGrid",
};

function shortName(pack: string): string {
	return pack.slice(pack.indexOf("/") + 1);
}

export function packTitle(pack: string): string {
	const short = shortName(pack);
	if (NAMES[short]) return NAMES[short];
	const words = short.replace(/-/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function PackMark({ manifest }: { manifest: PackManifest }) {
	if (cataloguePack(manifest.pack))
		return (
			<IntegrationLogo
				className="size-9 rounded-md"
				id={shortName(manifest.pack)}
				name={packTitle(manifest.pack)}
			/>
		);
	return (
		<span
			aria-hidden="true"
			className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-primary/10 text-primary"
		>
			<Workflow className="size-4" />
		</span>
	);
}

function PackRow({
	manifest,
	checked,
	onSelect,
}: {
	manifest: PackManifest;
	checked: boolean;
	onSelect: () => void;
}) {
	const actions = manifest.actions.length;
	return (
		<button
			aria-checked={checked}
			aria-label={`${packTitle(manifest.pack)} (${manifest.pack}), ${actions} ${actions === 1 ? "action" : "actions"}`}
			className={cn(
				"group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors",
				"focus-visible:ring-2 focus-visible:ring-ring/40",
				checked
					? "border-primary/60 bg-primary/5"
					: "border-transparent hover:bg-muted/70",
			)}
			onClick={onSelect}
			role="radio"
			type="button"
		>
			<PackMark manifest={manifest} />
			<span className="min-w-0 flex-1">
				<span className="flex items-baseline gap-2">
					<span className="font-medium text-sm">
						{packTitle(manifest.pack)}
					</span>
					<span className="truncate font-mono text-[11px] text-muted-foreground">
						{manifest.pack}
					</span>
				</span>
				<span className="mt-0.5 line-clamp-1 block text-muted-foreground text-xs">
					{manifest.description}
				</span>
			</span>
			<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
				{actions} {actions === 1 ? "action" : "actions"}
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
					checked
						? "border-primary bg-primary text-primary-foreground"
						: "border-border",
				)}
			>
				{checked ? <Check className="size-3" /> : null}
			</span>
		</button>
	);
}

export function PackPicker({
	packs,
	value,
	onChange,
	label = "Pack",
}: {
	packs: PackManifest[];
	value: string;
	onChange: (pack: string) => void;
	label?: string;
}) {
	const labelId = useId();
	const [query, setQuery] = useState("");
	const [browsing, setBrowsing] = useState(value === "");
	const selected = packs.find((pack) => pack.pack === value);

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matches = packs.filter(
			(pack) =>
				!q ||
				pack.pack.toLowerCase().includes(q) ||
				packTitle(pack.pack).toLowerCase().includes(q) ||
				pack.description.toLowerCase().includes(q),
		);
		const byTitle = (a: PackManifest, b: PackManifest) =>
			packTitle(a.pack).localeCompare(packTitle(b.pack));
		return [
			{
				title: "Workflows",
				hint: "Several integrations, set up together",
				packs: matches.filter((p) => !cataloguePack(p.pack)).sort(byTitle),
			},
			{
				title: "Integrations",
				hint: "Every action for one integration",
				packs: matches.filter((p) => cataloguePack(p.pack)).sort(byTitle),
			},
		].filter((group) => group.packs.length > 0);
	}, [packs, query]);

	if (selected && !browsing)
		return (
			<div className="space-y-1.5">
				<p className="font-medium text-sm">{label}</p>
				<div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
					<PackMark manifest={selected} />
					<div className="min-w-0 flex-1">
						<p className="flex items-baseline gap-2">
							<span className="font-medium text-sm">
								{packTitle(selected.pack)}
							</span>
							<span className="truncate font-mono text-[11px] text-muted-foreground">
								{selected.pack}
							</span>
						</p>
						<p className="mt-0.5 text-muted-foreground text-xs">
							{selected.description}
						</p>
					</div>
					<Button onClick={() => setBrowsing(true)} size="sm" variant="ghost">
						Change
					</Button>
				</div>
			</div>
		);

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between gap-3">
				<p className="font-medium text-sm" id={labelId}>
					{label}
				</p>
				<span className="text-muted-foreground text-xs tabular-nums">
					{packs.length} packs
				</span>
			</div>
			<div className="relative">
				<Search
					aria-hidden="true"
					className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground"
				/>
				<Input
					aria-label="Search packs"
					autoComplete="off"
					className="pl-9"
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search by integration or what it does"
					value={query}
				/>
			</div>
			<div
				aria-labelledby={labelId}
				className="-mx-1 max-h-80 space-y-3 overflow-y-auto px-1 py-1"
				role="radiogroup"
			>
				{groups.length === 0 ? (
					<p className="px-3 py-6 text-center text-muted-foreground text-sm">
						No pack matches “{query.trim()}”.
					</p>
				) : (
					groups.map((group) => (
						<div className="space-y-1" key={group.title}>
							<p className="flex items-baseline gap-2 px-3 pt-1">
								<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
									{group.title}
								</span>
								<span className="text-muted-foreground/80 text-xs">
									{group.hint}
								</span>
							</p>
							{group.packs.map((pack) => (
								<PackRow
									checked={pack.pack === value}
									key={pack.pack}
									manifest={pack}
									onSelect={() => {
										onChange(pack.pack);
										setBrowsing(false);
										setQuery("");
									}}
								/>
							))}
						</div>
					))
				)}
			</div>
		</div>
	);
}
