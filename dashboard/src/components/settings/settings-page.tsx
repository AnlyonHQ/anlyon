import {
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ListFrame, PageHeader } from "@/components/layout/page";
import { cn } from "@/lib/utils";

export function SettingsPage({
	title,
	description,
	actions,
	width = "default",
	sectionNav = true,
	children,
}: {
	title: string;
	description: ReactNode;
	actions?: ReactNode;
	width?: "default" | "wide";
	sectionNav?: boolean;
	children: ReactNode;
}) {
	const contentRef = useRef<HTMLDivElement>(null);
	const withNav = sectionNav && width === "default";
	return (
		<div
			className={cn(
				"mx-auto w-full motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200",
				width === "wide" ? "max-w-6xl" : "max-w-3xl",
				withNav &&
					"xl:grid xl:max-w-[62rem] xl:grid-cols-[minmax(0,1fr)_11rem] xl:gap-x-12",
			)}
		>
			<PageHeader
				actions={actions}
				className="mb-8 xl:col-start-1"
				description={description}
				title={title}
			/>
			<div
				className="flex min-w-0 flex-col gap-8 pb-16 xl:col-start-1 xl:row-start-2"
				data-slot="settings-content"
				ref={contentRef}
			>
				{children}
			</div>
			{withNav ? <SectionNav contentRef={contentRef} /> : null}
		</div>
	);
}

export function sectionSlug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export function SettingsSection({
	title,
	description,
	children,
	footer,
	actions,
	id,
	flush = false,
	framed,
	stickyFooter = false,
	variant = "default",
	className,
}: {
	title: string;
	description?: ReactNode;
	children?: ReactNode;
	footer?: ReactNode;
	actions?: ReactNode;
	id?: string;
	flush?: boolean;
	framed?: boolean;
	stickyFooter?: boolean;
	variant?: "default" | "danger";
	className?: string;
}) {
	const headingId = useId();
	const danger = variant === "danger";
	const hasFooter = Boolean(footer);
	const isFramed = framed ?? (hasFooter || danger || flush);
	return (
		<section
			aria-labelledby={headingId}
			className={cn(
				"flex min-w-0 scroll-mt-20 flex-col gap-4",
				"[[data-settings-section]+&]:border-t [[data-settings-section]+&]:pt-8",
				className,
			)}
			data-settings-section={title}
			id={id ?? sectionSlug(title)}
		>
			<header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
				<div className="min-w-0 max-w-2xl flex-1 basis-64">
					<h3
						className={cn(
							"font-semibold text-[15px] text-foreground leading-6 tracking-tight",
							danger && "text-destructive",
						)}
						id={headingId}
					>
						{title}
					</h3>
					{description ? (
						<p className="mt-0.5 text-pretty text-muted-foreground text-sm leading-relaxed">
							{description}
						</p>
					) : null}
				</div>
				{actions ? (
					<div className="flex shrink-0 flex-wrap items-center gap-2">
						{actions}
					</div>
				) : null}
			</header>
			{isFramed && (children || hasFooter) ? (
				<div
					className={cn(
						"min-w-0 rounded-lg border bg-card text-card-foreground",
						danger && "border-destructive/30",
					)}
					data-slot="settings-frame"
				>
					{children ? (
						<div
							className={cn(
								"min-w-0",
								flush
									? "overflow-hidden rounded-t-lg [&>:first-child]:border-t-0"
									: "p-5",
								flush && !hasFooter && "rounded-b-lg",
							)}
						>
							{children}
						</div>
					) : null}
					{hasFooter ? (
						<footer
							className={cn(
								"flex flex-wrap items-center justify-end gap-3 px-5 py-3",
								children ? "rounded-b-lg border-t" : "rounded-lg",
								danger
									? "border-destructive/20 bg-destructive/[0.03]"
									: "bg-muted/40",
								stickyFooter &&
									"sticky bottom-0 z-[1] bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75",
							)}
						>
							{footer}
						</footer>
					) : null}
				</div>
			) : (
				<>
					{children ? <div className="min-w-0">{children}</div> : null}
					{hasFooter ? (
						<div className="flex flex-wrap items-center gap-3">{footer}</div>
					) : null}
				</>
			)}
		</section>
	);
}

export function LearnMore({ href }: { href: string }) {
	return (
		<a
			className="whitespace-nowrap text-foreground underline underline-offset-2 hover:no-underline"
			href={href}
			rel="noreferrer"
			target="_blank"
		>
			Learn more
		</a>
	);
}

export function SettingsRow({
	label,
	description,
	children,
}: {
	label: ReactNode;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
			<div className="min-w-0 flex-1 basis-64">
				<div className="text-sm">{label}</div>
				{description ? (
					<div className="mt-0.5 max-w-xl text-pretty text-muted-foreground text-xs leading-relaxed">
						{description}
					</div>
				) : null}
			</div>
			<div className="flex min-w-0 items-center gap-2">{children}</div>
		</div>
	);
}

interface NavItem {
	id: string;
	title: string;
}

function viewTop(element: HTMLElement): number {
	let node: HTMLElement | null = element.parentElement;
	while (node) {
		const { overflowY } = getComputedStyle(node);
		if (overflowY === "auto" || overflowY === "scroll")
			return node.getBoundingClientRect().top;
		node = node.parentElement;
	}
	return 0;
}

function useSections(contentRef: RefObject<HTMLDivElement | null>) {
	const [items, setItems] = useState<NavItem[]>([]);
	useLayoutEffect(() => {
		const root = contentRef.current;
		if (!root) return;
		const read = () => {
			const next = Array.from(
				root.querySelectorAll<HTMLElement>("section[data-settings-section]"),
			).map((section) => ({
				id: section.id,
				title: section.dataset.settingsSection ?? "",
			}));
			setItems((current) =>
				current.length === next.length &&
				current.every(
					(item, index) =>
						item.id === next[index]?.id && item.title === next[index]?.title,
				)
					? current
					: next,
			);
		};
		read();
		const observer = new MutationObserver(read);
		observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [contentRef]);
	return items;
}

const NAV_MIN = 3;

function SectionNav({
	contentRef,
}: {
	contentRef: RefObject<HTMLDivElement | null>;
}) {
	const items = useSections(contentRef);
	const [active, setActive] = useState<string | null>(null);

	useEffect(() => {
		const root = contentRef.current;
		if (!root || items.length < NAV_MIN) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			const line = viewTop(root) + 120;
			let current = items[0]?.id ?? null;
			for (const item of items) {
				const element = document.getElementById(item.id);
				if (element && element.getBoundingClientRect().top <= line)
					current = item.id;
			}
			setActive(current);
		};
		const onScroll = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		update();
		document.addEventListener("scroll", onScroll, {
			capture: true,
			passive: true,
		});
		window.addEventListener("resize", onScroll);
		return () => {
			document.removeEventListener("scroll", onScroll, { capture: true });
			window.removeEventListener("resize", onScroll);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [contentRef, items]);

	if (items.length < NAV_MIN) return null;
	return (
		<nav
			aria-label="On this page"
			className="hidden xl:col-start-2 xl:row-start-2 xl:block"
		>
			<div className="sticky top-20">
				<p className="mb-3 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.04em]">
					On this page
				</p>
				<ul className="flex flex-col border-l">
					{items.map((item) => {
						const isActive = item.id === active;
						return (
							<li key={item.id}>
								<a
									aria-current={isActive ? "location" : undefined}
									className={cn(
										"-ml-px block border-l-2 py-1.5 pr-2 pl-3.5 text-[13px] leading-5 outline-none transition-colors duration-150 ease-out focus-visible:rounded-r-md focus-visible:ring-2 focus-visible:ring-ring",
										isActive
											? "border-brand font-medium text-foreground"
											: "border-transparent text-muted-foreground hover:border-foreground/20 hover:text-foreground",
									)}
									href={`#${item.id}`}
									onClick={(event) => {
										const target = document.getElementById(item.id);
										if (!target) return;
										event.preventDefault();
										const reduce = window.matchMedia(
											"(prefers-reduced-motion: reduce)",
										).matches;
										target.scrollIntoView({
											behavior: reduce ? "auto" : "smooth",
											block: "start",
										});
										history.replaceState(null, "", `#${item.id}`);
										setActive(item.id);
									}}
								>
									{item.title}
								</a>
							</li>
						);
					})}
				</ul>
			</div>
		</nav>
	);
}

export function SettingsTableFrame({
	children,
	className,
	footer,
}: {
	children: ReactNode;
	className?: string;
	footer?: ReactNode;
}) {
	return (
		<ListFrame
			className={cn(
				"[&_tbody_tr:last-child]:border-0",
				"in-data-[slot=settings-frame]:rounded-none in-data-[slot=settings-frame]:border-0 in-data-[slot=settings-frame]:bg-transparent",
				className,
			)}
			footer={footer}
		>
			{children}
		</ListFrame>
	);
}

export function ListEmpty({
	children,
	action,
}: {
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4">
			<p className="min-w-0 text-pretty text-muted-foreground text-sm">
				{children}
			</p>
			{action ? (
				<div className="flex shrink-0 items-center gap-2">{action}</div>
			) : null}
		</div>
	);
}
