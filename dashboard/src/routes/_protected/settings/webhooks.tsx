import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
	DisplaySecretDialog,
	maskSecret,
	RegenerateSecretDialog,
} from "@/components/settings";
import {
	LearnMore,
	SettingsPage,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { useWorkspace } from "@/contexts/workspace-context";
import { useCan } from "@/hooks/api/use-permissions";
import {
	useCreateDeliverySecret,
	useDeliverySecret,
	useRegenerateDeliverySecret,
} from "@/hooks/api/use-workspaces";
import { copyToClipboard } from "@/lib/utils";

export const Route = createFileRoute("/_protected/settings/webhooks")({
	component: WebhooksSettingsPage,
});

function WebhooksSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id ?? "";
	const { data: deliverySecret, isLoading } = useDeliverySecret(workspaceId);
	const createSecret = useCreateDeliverySecret();
	const regenerateSecret = useRegenerateDeliverySecret();
	const canManageKeys = useCan(workspaceId || undefined)("keys.manage");

	const [createdSecret, setCreatedSecret] = useState<string | null>(null);
	const [showSecret, setShowSecret] = useState(false);
	const [isCopied, setIsCopied] = useState(false);
	const [dialog, setDialog] = useState<"display" | "regenerate" | null>(null);

	const closeDisplay = () => {
		setCreatedSecret(null);
		setShowSecret(false);
		setIsCopied(false);
		setDialog(null);
	};

	return (
		<SettingsPage
			title="Webhooks"
			description={
				<>
					Signs the events Anlyon sends to your endpoints. Add an endpoint under{" "}
					<Link
						className="underline underline-offset-2"
						search={{ topic: undefined }}
						to="/events"
					>
						Event topics
					</Link>
					. <LearnMore href="https://docs.anlyon.com/guides/webhooks" />
				</>
			}
		>
			<SettingsSection
				title="Workspace delivery signing secret"
				description="Signs the Anlyon-Signature header on deliveries whose subscription has no secret of its own; with neither, a delivery is unsigned. Shown once at creation. Action invocations carry no Anlyon signature."
				footer={
					!canManageKeys ? undefined : deliverySecret ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setDialog("regenerate")}
							disabled={regenerateSecret.isPending}
						>
							Regenerate
						</Button>
					) : (
						<Button
							size="sm"
							disabled={createSecret.isPending || isLoading}
							onClick={async () => {
								if (!workspaceId) return;
								const result = await createSecret.mutateAsync(workspaceId);
								setCreatedSecret(result.secretKey);
								setDialog("display");
							}}
						>
							{createSecret.isPending ? "Creating…" : "Create secret"}
						</Button>
					)
				}
			>
				{isLoading ? (
					<Skeleton className="h-9 w-64" />
				) : deliverySecret ? (
					<code className="inline-flex rounded-md bg-muted px-2.5 py-1 font-mono text-sm">
						{deliverySecret.secretPrefix}••••••••••••••••
					</code>
				) : (
					<p className="text-sm text-muted-foreground">
						No workspace signing secret yet. A delivery is unsigned unless its
						subscription has a secret of its own.
					</p>
				)}
			</SettingsSection>

			<SettingsSection
				title="Verifying signatures"
				description="Both SDKs ship a Receiver that verifies the Anlyon-Signature header with this secret. It rejects a signature whose timestamp is more than 5 minutes from now. It does not remember deliveries it has seen, so use the X-Idempotency-Key header to drop a repeat."
			>
				<pre className="overflow-x-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
					{`import { Receiver } from "@anlyonhq/sdk";

const receiver = new Receiver({ signingSecret: process.env.ANLYON_SIGNING_SECRET! });
// signature is the Anlyon-Signature header. body is the raw request body.
const valid = receiver.verify({ signature, body });`}
				</pre>
			</SettingsSection>

			<DisplaySecretDialog
				open={dialog === "display"}
				onOpenChange={(open) => {
					if (!open) closeDisplay();
				}}
				displayValue={
					showSecret ? (createdSecret ?? "") : maskSecret(createdSecret ?? "")
				}
				showValue={showSecret}
				onToggleShow={() => setShowSecret((v) => !v)}
				isCopied={isCopied}
				onCopy={async () => {
					if (!createdSecret) return;
					const result = await copyToClipboard(createdSecret);
					if (result.success) {
						setIsCopied(true);
						toast.success("Secret copied");
						setTimeout(() => setIsCopied(false), 2000);
					} else toast.error(result.error || "Copy failed");
				}}
				onClose={closeDisplay}
			/>

			<RegenerateSecretDialog
				open={dialog === "regenerate"}
				onOpenChange={(open) => setDialog(open ? "regenerate" : null)}
				isPending={regenerateSecret.isPending}
				onConfirm={async () => {
					if (!workspaceId) return;
					const result = await regenerateSecret.mutateAsync(workspaceId);
					setCreatedSecret(result.secretKey);
					setDialog("display");
				}}
			/>
		</SettingsPage>
	);
}
