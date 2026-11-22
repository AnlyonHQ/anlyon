import {
	MutationCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";

import { publishQuotaFeedback } from "@/lib/quota-feedback";

export function getContext() {
	const queryClient = new QueryClient({
		mutationCache: new MutationCache({ onError: publishQuotaFeedback }),
	});
	return {
		queryClient,
	};
}

export function Provider({
	children,
	queryClient,
}: {
	children: React.ReactNode;
	queryClient: QueryClient;
}) {
	return (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}
