import { AppShell } from "../shell/app-shell";

export function AppLayout({ children }: { children: React.ReactNode }) {
	return <AppShell>{children}</AppShell>;
}
