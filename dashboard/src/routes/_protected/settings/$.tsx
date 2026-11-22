import { createFileRoute } from "@tanstack/react-router";
import { ExtensionPageView } from "@/components/extension-slots";
import { forwardExtensionPage, passSearch } from "@/lib/extension-routes";

export const Route = createFileRoute("/_protected/settings/$")({
	validateSearch: passSearch,
	beforeLoad: ({ location }) => forwardExtensionPage(location.pathname),
	component: ExtensionPageView,
});
