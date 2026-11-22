/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationPopover } from "./notification-popover";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: React.ReactNode }) => (
		<a href="/">{children}</a>
	),
}));

vi.mock("@/contexts/workspace-context", () => ({
	useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }),
}));

vi.mock("@/hooks/api/use-notifications", () => ({
	useNotifications: () => ({ data: [], isLoading: false }),
	useUnreadNotificationCount: () => ({ data: 1 }),
	useMarkNotificationRead: () => ({ mutate: vi.fn() }),
	useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
	useDismissNotification: () => ({ mutate: vi.fn() }),
}));

describe("NotificationPopover", () => {
	afterEach(cleanup);

	it("opens when the bell button is clicked", () => {
		render(<NotificationPopover />);

		expect(screen.queryByText("Notifications")).toBeNull();
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("Notifications")).toBeTruthy();
	});
});
