import { PageTabs } from "@/components/layout/page";

export function EventsTabs() {
	return (
		<PageTabs
			items={[
				{
					label: "Events",
					to: "/events/recent",
					search: { event: undefined, topic: undefined },
				},
				{ label: "Topics", to: "/events", search: { topic: undefined } },
			]}
			label="Events views"
		/>
	);
}
