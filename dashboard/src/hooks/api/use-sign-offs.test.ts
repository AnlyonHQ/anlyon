import { afterEach, describe, expect, it, vi } from "vitest";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/api-client")>()),
	apiClient: { get },
}));
vi.mock("@/components/ui/toast", () => ({ toast: {} }));

const { ApiError } = await import("@/lib/api-client");
const { findSignOff } = await import("./use-sign-offs");

afterEach(() => get.mockReset());

const notFound = () => new ApiError("Not found", 404, "NOT_FOUND");

describe("findSignOff", () => {
	it("asks the current workspace first and stops there when it has it", async () => {
		get.mockResolvedValueOnce({ id: "sor_1" });
		await expect(findSignOff("sor_1", ["ws_a", "ws_b"])).resolves.toEqual({
			workspaceId: "ws_a",
			signOff: { id: "sor_1" },
		});
		expect(get).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledWith("/workspaces/ws_a/sign-offs/sor_1");
	});

	it("tries the other workspaces on a 404, skipping ones that refuse", async () => {
		get
			.mockRejectedValueOnce(notFound())
			.mockRejectedValueOnce(new ApiError("Forbidden", 403))
			.mockResolvedValueOnce({ id: "sor_1" });
		await expect(
			findSignOff("sor_1", ["ws_a", "ws_b", "ws_c"]),
		).resolves.toEqual({ workspaceId: "ws_c", signOff: { id: "sor_1" } });
	});

	it("resolves to null when no workspace has it", async () => {
		get.mockRejectedValue(notFound());
		await expect(findSignOff("sor_1", ["ws_a", "ws_b"])).resolves.toBeNull();
	});

	it("surfaces the current workspace's error when no other workspace has it", async () => {
		get
			.mockRejectedValueOnce(new ApiError("Forbidden", 403))
			.mockRejectedValueOnce(notFound());
		await expect(findSignOff("sor_1", ["ws_a", "ws_b"])).rejects.toThrow(
			"Forbidden",
		);
		expect(get).toHaveBeenCalledTimes(2);
	});
});
