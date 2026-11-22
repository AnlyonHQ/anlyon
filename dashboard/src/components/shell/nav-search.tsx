import { Link, useNavigate } from "@tanstack/react-router";
import type React from "react";
import { useCallback, useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import { type NavSearchEntry, searchNavigation } from "./nav-config";

export const NAV_SEARCH_ID = "nav-search";

function isTyping(target: EventTarget | null) {
	const el = target as HTMLElement | null;
	return (
		!!el &&
		(el.isContentEditable ||
			["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
	);
}

export function useFocusNavSearch() {
	const { isMobile, setOpen, setOpenMobile } = useSidebar();
	return useCallback(() => {
		if (isMobile) setOpenMobile(true);
		else setOpen(true);
		let tries = 0;
		const focus = () => {
			const field = document.getElementById(NAV_SEARCH_ID);
			if (field) field.focus();
			else if (tries++ < 10) requestAnimationFrame(focus);
		};
		requestAnimationFrame(focus);
	}, [isMobile, setOpen, setOpenMobile]);
}

export function NavSearch({
	entries,
	query,
	onQueryChange,
}: {
	entries: NavSearchEntry[];
	query: string;
	onQueryChange: (query: string) => void;
}) {
	const navigate = useNavigate();
	const { isMobile, setOpenMobile, state } = useSidebar();
	const focusSearch = useFocusNavSearch();
	const [highlighted, setHighlighted] = useState(0);
	const results = searchNavigation(entries, query);
	const listId = useId();

	useEffect(() => {
		if (state === "collapsed" && !isMobile) onQueryChange("");
	}, [state, isMobile, onQueryChange]);

	useEffect(() => {
		function onKey(event: KeyboardEvent) {
			if (
				event.key !== "/" ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				isTyping(event.target)
			) {
				return;
			}
			event.preventDefault();
			focusSearch();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [focusSearch]);

	const go = (entry: NavSearchEntry | undefined) => {
		if (!entry) return;
		onQueryChange("");
		document.getElementById(NAV_SEARCH_ID)?.blur();
		if (isMobile) setOpenMobile(false);
		void navigate({ to: entry.href });
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			onQueryChange("");
			event.currentTarget.blur();
		} else if (event.key === "ArrowDown" && results.length) {
			event.preventDefault();
			setHighlighted((i) => (i + 1) % results.length);
		} else if (event.key === "ArrowUp" && results.length) {
			event.preventDefault();
			setHighlighted((i) => (i - 1 + results.length) % results.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			go(results[highlighted] ?? results[0]);
		}
	};

	const active = results.length
		? Math.min(highlighted, results.length - 1)
		: -1;

	return (
		<>
			<div className="relative">
				<Input
					aria-activedescendant={
						active >= 0 ? `${listId}-${active}` : undefined
					}
					aria-autocomplete="list"
					aria-controls={query ? listId : undefined}
					aria-expanded={!!query}
					aria-label="Search pages"
					autoComplete="off"
					id={NAV_SEARCH_ID}
					onChange={(event) => {
						onQueryChange(event.target.value);
						setHighlighted(0);
					}}
					onKeyDown={onKeyDown}
					placeholder="Search pages"
					role="combobox"
					size="sm"
					type="search"
					value={query}
				/>
				{query ? null : (
					<Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 max-md:hidden">
						/
					</Kbd>
				)}
			</div>
			{query ? (
				results.length ? (
					<SidebarMenu className="mt-2" id={listId} role="listbox">
						{results.map((entry, index) => (
							<SidebarMenuItem
								aria-selected={index === active}
								id={`${listId}-${index}`}
								key={entry.href}
								role="option"
							>
								<SidebarMenuButton
									isActive={index === active}
									onMouseEnter={() => setHighlighted(index)}
									render={
										<Link
											onClick={(event) => {
												event.preventDefault();
												go(entry);
											}}
											tabIndex={-1}
											to={entry.href}
										>
											<entry.icon />
											<span className="truncate">
												<span className="text-sidebar-muted-foreground">
													{entry.section} ›{" "}
												</span>
												{entry.title}
											</span>
										</Link>
									}
									size="default"
								/>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				) : (
					<p className="px-2 py-2 text-sidebar-muted-foreground text-sm">
						No pages match “{query.trim()}”.
					</p>
				)
			) : null}
		</>
	);
}
