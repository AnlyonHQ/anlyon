import { Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import type { SlackChannel } from "@/lib/types";

export interface SlackChannelOption {
	id: string;
	name: string;
}

export interface SlackChannelDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	channels: SlackChannel[] | undefined;
	isLoading: boolean;
	selectedChannel: SlackChannelOption | null;
	onSelectChannel: (channel: SlackChannelOption) => void;
	onSubmit: () => void;
	isPending: boolean;
	onClose: () => void;
}

export function SlackChannelDialog({
	open,
	onOpenChange,
	channels,
	isLoading,
	selectedChannel,
	onSelectChannel,
	onSubmit,
	isPending,
	onClose,
}: SlackChannelDialogProps) {
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) onClose();
				onOpenChange(o);
			}}
		>
			<DialogPopup className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Select Slack Channel</DialogTitle>
					<DialogDescription>
						Choose which Slack channel should receive notifications. PUBLIC
						channels: bot joins automatically. PRIVATE channels: invite the bot
						with <code className="rounded bg-muted px-1">/invite @Anlyon</code>.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel>
					<Field>
						{isLoading ? (
							<div className="space-y-2">
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-10 w-full" />
								<Skeleton className="h-10 w-full" />
							</div>
						) : channels && channels.length > 0 ? (
							<div className="grid max-h-64 grid-cols-2 gap-2 space-y-2 overflow-y-auto">
								{channels.map((channel) => (
									<label
										key={channel.id}
										className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
											selectedChannel?.id === channel.id
												? "border-primary bg-primary/5"
												: "hover:border-primary/50"
										}`}
									>
										<input
											type="radio"
											name="slackChannel"
											value={channel.id}
											checked={selectedChannel?.id === channel.id}
											onChange={() =>
												onSelectChannel({ id: channel.id, name: channel.name })
											}
											className="text-primary"
										/>
										<div className="flex-1">
											<div className="font-medium">#{channel.name}</div>
											<div className="flex items-center gap-1 text-xs text-muted-foreground">
												{channel.isPrivate ? (
													<>
														<span>Private •</span>
														{channel.isMember ? (
															<span className="text-success">Bot added ✓</span>
														) : (
															<span className="text-warning">
																Manual invite needed after selection
															</span>
														)}
													</>
												) : (
													<>
														<span>Public •</span>
														{channel.isMember ? (
															<span className="text-success">Bot added ✓</span>
														) : (
															<span className="text-info">Will auto-join</span>
														)}
													</>
												)}
											</div>
										</div>
									</label>
								))}
							</div>
						) : (
							<div className="py-8 text-center">
								<Hash className="mx-auto mb-3 h-12 w-12 text-muted-foreground/50" />
								<p className="mb-2 text-sm text-muted-foreground">
									No channels found
								</p>
								<p className="text-xs text-muted-foreground">
									Make sure the Anlyon app has been added to your Slack
									channels.
								</p>
							</div>
						)}
					</Field>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button onClick={onSubmit} disabled={isPending || !selectedChannel}>
						{isPending ? "Saving..." : "Select Channel"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
