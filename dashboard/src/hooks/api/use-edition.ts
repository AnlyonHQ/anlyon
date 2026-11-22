import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { isSelfHosted } from "@/lib/runtime-config";

export interface EditionStatus {
	edition: "cloud" | "community" | "team" | "enterprise";
	license: {
		state: "valid" | "grace" | "invalid";
		reason?: string;
		message: string;
		tier: "team" | "enterprise" | null;
		org: string | null;
		seats: number | null;
		seatsUsed: number;
		overSeats: boolean;
		features: string[];
		expiresAt: string | null;
		graceEndsAt: string | null;
	} | null;
}

export function useEdition() {
	return useQuery({
		queryKey: ["edition"],
		queryFn: () => apiClient.get<EditionStatus>("/edition"),
		enabled: isSelfHosted(),
		staleTime: 5 * 60 * 1000,
	});
}
