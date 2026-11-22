import { useId, useState } from "react";
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
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateFunction } from "@/hooks/api/use-functions";
import { NAME_PATTERN } from "@/lib/functions";
import type { HostedFunction } from "@/lib/types";

export function CreateFunctionDialog({
	workspaceId,
	onCreated,
}: {
	workspaceId?: string;
	onCreated?: (created: HostedFunction) => void;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const create = useCreateFunction(workspaceId);
	const nameInvalid = name !== "" && !NAME_PATTERN.test(name);

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm">New function</Button>} />
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>Create function</DialogTitle>
					<DialogDescription>
						Name the function. It runs nothing until you publish a version of
						its source.
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="space-y-4 py-2">
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-name`}>Name</Label>
						<Input
							aria-describedby={`${id}-name-hint`}
							aria-invalid={nameInvalid || undefined}
							autoCapitalize="none"
							id={`${id}-name`}
							maxLength={100}
							onChange={(e) => setName(e.target.value)}
							placeholder="refund-with-checks"
							spellCheck={false}
							value={name}
						/>
						<p
							className={
								nameInvalid
									? "text-destructive text-xs"
									: "text-muted-foreground text-xs"
							}
							id={`${id}-name-hint`}
						>
							Letters, digits, - and _. Runs call it by this name.
						</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-description`}>Description</Label>
						<Input
							id={`${id}-description`}
							maxLength={1000}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Refund an order after checking it was paid."
							value={description}
						/>
					</div>
				</DialogPanel>
				<DialogFooter>
					<DialogClose render={<Button variant="outline">Cancel</Button>} />
					<Button
						disabled={!name || nameInvalid}
						loading={create.isPending}
						onClick={() =>
							create.mutate(
								{ name, description: description || undefined },
								{
									onSuccess: (created) => {
										setOpen(false);
										setName("");
										setDescription("");
										onCreated?.(created);
									},
								},
							)
						}
					>
						Create
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
