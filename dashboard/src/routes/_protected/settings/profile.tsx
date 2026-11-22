import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
	SettingsPage,
	SettingsRow,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useAuth } from "@/hooks/use-auth";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_protected/settings/profile")({
	component: ProfileSettingsPage,
});

function ProfileSettingsPage() {
	const { user } = useAuth();
	const queryClient = useQueryClient();
	const [name, setName] = useState(user?.name ?? "");
	const [saving, setSaving] = useState(false);
	const dirty = name.trim().length > 0 && name.trim() !== user?.name;

	return (
		<SettingsPage
			title="Profile"
			description="Your account across every workspace."
		>
			<SettingsSection
				title="Display name"
				description="How you appear in members lists and on the approvals you decide."
				footer={
					<Button
						size="sm"
						disabled={!dirty || saving}
						onClick={async () => {
							setSaving(true);
							try {
								await authClient.updateUser({ name: name.trim() });
								await queryClient.invalidateQueries({
									queryKey: ["auth", "session"],
								});
								toast.success("Profile updated");
							} catch {
								toast.error("Failed to update profile");
							} finally {
								setSaving(false);
							}
						}}
					>
						{saving ? "Saving…" : "Save"}
					</Button>
				}
			>
				<Input
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="max-w-sm"
					aria-label="Display name"
					maxLength={100}
				/>
			</SettingsSection>

			<SettingsSection title="Account">
				<div className="divide-y divide-border/70">
					<SettingsRow
						label="Email"
						description="Your sign-in identity. Email changes aren't supported yet; contact support if you need one."
					>
						<span className="truncate font-mono text-sm" translate="no">
							{user?.email ?? ""}
						</span>
					</SettingsRow>
					<SettingsRow
						label="Session"
						description="Signing out ends this browser session only. API keys are unaffected."
					>
						<Button
							size="sm"
							variant="outline"
							onClick={async () => {
								await authClient.signOut();
								window.location.href = "/auth/login";
							}}
						>
							Sign out
						</Button>
					</SettingsRow>
				</div>
			</SettingsSection>
		</SettingsPage>
	);
}
