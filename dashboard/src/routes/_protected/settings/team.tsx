import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	Clock,
	Eye,
	Gavel,
	KeyRound,
	Layers,
	LifeBuoy,
	Mail,
	MoreHorizontal,
	Send,
	Shield,
	ShieldCheck,
	UserMinus,
	UserPlus,
	X,
} from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { EnvironmentRolesDialog } from "@/components/settings/environment-roles-dialog";
import {
	ListEmpty,
	SettingsPage,
	SettingsRow,
	SettingsSection,
	SettingsTableFrame,
} from "@/components/settings/settings-page";
import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/menu";
import { RelativeTime } from "@/components/ui/relative-time";
import {
	Select,
	SelectItem,
	SelectPopup,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { useWorkspace } from "@/contexts/workspace-context";
import { useEnvironments } from "@/hooks/api/use-environments";
import {
	ASSIGNABLE_ROLE_ORDER,
	ROLE_DESCRIPTIONS,
	ROLE_LABELS,
	useCan,
	useWorkspacePermissions,
} from "@/hooks/api/use-permissions";
import {
	useCancelInvitation,
	useCreateInvitation,
	useLeaveWorkspace,
	useRemoveMember,
	useResendInvitation,
	useSetEmergencyAccess,
	useUpdateMemberRole,
	useWorkspaceInvitations,
	useWorkspaceMembers,
	type WorkspaceInvitation,
} from "@/hooks/api/use-workspaces";
import { useAuth } from "@/hooks/use-auth";
import type { AssignableRole, Role, WorkspaceMember } from "@/lib/types";

export const Route = createFileRoute("/_protected/settings/team")({
	component: TeamPage,
});

const emailSchema = z.string().email("Enter a valid email address");

function TeamPage() {
	const { user } = useAuth();
	const navigate = useNavigate();
	const { currentWorkspace } = useWorkspace();
	const { data: members, isLoading } = useWorkspaceMembers(
		currentWorkspace?.id || "",
	);
	const { data: invitations } = useWorkspaceInvitations(
		currentWorkspace?.id || "",
	);
	const createInvitation = useCreateInvitation();
	const resendInvitation = useResendInvitation();
	const cancelInvitation = useCancelInvitation();
	const updateMemberRole = useUpdateMemberRole();
	const removeMember = useRemoveMember();
	const leaveWorkspace = useLeaveWorkspace();
	const setEmergencyAccess = useSetEmergencyAccess();
	const can = useCan(currentWorkspace?.id);
	const permissions = useWorkspacePermissions(currentWorkspace?.id);
	const environments = useEnvironments(currentWorkspace?.id).data ?? [];
	const environmentRolesEnabled =
		permissions.data?.environmentRolesEnabled ?? false;
	const environmentName = (id: string) =>
		environments.find((env) => env.id === id)?.name ?? "Unknown environment";

	const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
	const [isRoleDialogOpen, setIsRoleDialogOpen] = useState(false);
	const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);
	const [isLeaveDialogOpen, setIsLeaveDialogOpen] = useState(false);
	const [isEmergencyDialogOpen, setIsEmergencyDialogOpen] = useState(false);
	const [isEnvRolesDialogOpen, setIsEnvRolesDialogOpen] = useState(false);
	const [selectedMember, setSelectedMember] = useState<WorkspaceMember | null>(
		null,
	);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteLink, setInviteLink] = useState<{
		email: string;
		url: string;
	} | null>(null);
	const [inviteRole, setInviteRole] = useState<AssignableRole>("member");
	const [newRole, setNewRole] = useState<AssignableRole>("member");
	const [emergencyTarget, setEmergencyTarget] =
		useState<WorkspaceMember | null>(null);
	const emergencyTargetName =
		emergencyTarget?.user?.name || emergencyTarget?.user?.email || "this admin";
	const emergencyEnabling = !emergencyTarget?.emergencyAccess;

	const pendingInvitations =
		invitations?.filter((inv) => inv.status === "pending") || [];

	const currentUserMember = members?.find((m) => m.userId === user?.id);
	const canManageMembers = can("members.manage");
	const hasEmergencyAccess =
		permissions.data?.emergencyAccess ??
		currentUserMember?.emergencyAccess ??
		false;
	const admins = members?.filter((m) => m.role === "admin") ?? [];
	const emergencyAdmins = admins.filter((m) => m.emergencyAccess);
	const isLastAdmin =
		currentUserMember?.role === "admin" &&
		(admins.length === 1 ||
			(currentUserMember.emergencyAccess === true &&
				emergencyAdmins.length === 1));

	const getRoleBadge = (role: Role) => {
		switch (role) {
			case "admin":
				return (
					<Badge variant="outline">
						<ShieldCheck className="mr-1 h-3 w-3" />
						Admin
					</Badge>
				);
			case "member":
				return (
					<Badge variant="outline">
						<Shield className="mr-1 h-3 w-3" />
						Member
					</Badge>
				);
			case "approver":
				return (
					<Badge variant="outline">
						<Gavel className="mr-1 h-3 w-3" />
						Approver
					</Badge>
				);
			case "viewer":
				return (
					<Badge variant="outline">
						<Eye className="mr-1 h-3 w-3" />
						Viewer
					</Badge>
				);
		}
	};

	const roleOptions = ASSIGNABLE_ROLE_ORDER.map((role) => (
		<SelectItem key={role} value={role}>
			<div className="flex flex-col">
				<span>{ROLE_LABELS[role]}</span>
				<span className="text-xs text-muted-foreground">
					{ROLE_DESCRIPTIONS[role]}
				</span>
			</div>
		</SelectItem>
	));

	const handleInviteMember = async () => {
		if (!currentWorkspace?.id || !inviteEmail.trim()) {
			toastManager.add({
				title: "Enter an email address.",
				type: "error",
			});
			return;
		}

		const emailValidation = emailSchema.safeParse(inviteEmail.trim());
		if (!emailValidation.success) {
			toastManager.add({
				title: "Invalid email address.",
				description:
					emailValidation.error.issues[0]?.message ||
					"Enter a valid email address.",
				type: "error",
			});
			return;
		}

		try {
			const invitation = await createInvitation.mutateAsync({
				workspaceId: currentWorkspace.id,
				data: { email: inviteEmail.trim(), role: inviteRole },
			});
			if (invitation.inviteUrl) {
				setInviteLink({ email: invitation.email, url: invitation.inviteUrl });
			}
			setInviteEmail("");
			setInviteRole("member");
			setIsInviteDialogOpen(false);
		} catch (error) {
		}
	};

	const handleResendInvitation = async (invitation: WorkspaceInvitation) => {
		if (!currentWorkspace?.id) return;
		try {
			const resent = await resendInvitation.mutateAsync({
				workspaceId: currentWorkspace.id,
				invitationId: invitation.id,
			});
			if (resent.inviteUrl) {
				setInviteLink({ email: resent.email, url: resent.inviteUrl });
			}
		} catch (error) {
		}
	};

	const handleCancelInvitation = async (invitation: WorkspaceInvitation) => {
		if (!currentWorkspace?.id) return;
		try {
			await cancelInvitation.mutateAsync({
				workspaceId: currentWorkspace.id,
				invitationId: invitation.id,
			});
		} catch (error) {
		}
	};

	const handleUpdateRole = async () => {
		if (!currentWorkspace?.id || !selectedMember) return;

		try {
			await updateMemberRole.mutateAsync({
				workspaceId: currentWorkspace.id,
				userId: selectedMember.userId,
				data: { role: newRole },
			});
			setIsRoleDialogOpen(false);
			setSelectedMember(null);
		} catch (error) {
		}
	};

	const handleRemoveMember = async () => {
		if (!currentWorkspace?.id || !selectedMember) return;

		try {
			await removeMember.mutateAsync({
				workspaceId: currentWorkspace.id,
				userId: selectedMember.userId,
			});
			setIsRemoveDialogOpen(false);
			setSelectedMember(null);
		} catch (error) {
		}
	};

	const handleLeaveWorkspace = async () => {
		if (!currentWorkspace?.id) return;

		try {
			await leaveWorkspace.mutateAsync(currentWorkspace.id);
			setIsLeaveDialogOpen(false);
			navigate({ to: "/workspaces/select" });
		} catch (error) {
		}
	};

	const handleSetEmergencyAccess = async () => {
		if (!currentWorkspace?.id || !emergencyTarget) return;

		try {
			await setEmergencyAccess.mutateAsync({
				workspaceId: currentWorkspace.id,
				userId: emergencyTarget.userId,
				data: { enabled: !emergencyTarget.emergencyAccess },
			});
			setIsEmergencyDialogOpen(false);
			setEmergencyTarget(null);
		} catch (error) {
		}
	};

	const openEmergencyDialog = (member: WorkspaceMember) => {
		setEmergencyTarget(member);
		setIsEmergencyDialogOpen(true);
	};

	const openRoleDialog = (member: WorkspaceMember) => {
		setSelectedMember(member);
		setNewRole(member.role);
		setIsRoleDialogOpen(true);
	};

	const openEnvRolesDialog = (member: WorkspaceMember) => {
		setSelectedMember(member);
		setIsEnvRolesDialogOpen(true);
	};

	const openRemoveDialog = (member: WorkspaceMember) => {
		setSelectedMember(member);
		setIsRemoveDialogOpen(true);
	};

	const getInitials = (name?: string, email?: string) => {
		if (name) {
			return name
				.split(" ")
				.map((n) => n[0])
				.join("")
				.toUpperCase()
				.slice(0, 2);
		}
		if (email) {
			return email[0].toUpperCase();
		}
		return "?";
	};

	const adminCount = admins.length;

	return (
		<SettingsPage
			title="Team"
			description="Who can reach this workspace, and with which role."
			actions={
				canManageMembers ? (
					<Button onClick={() => setIsInviteDialogOpen(true)}>
						<UserPlus aria-hidden="true" />
						Invite member
					</Button>
				) : undefined
			}
		>
			{isLoading ? (
				<SettingsTableFrame>
					<div className="space-y-2 p-4">
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
					</div>
				</SettingsTableFrame>
			) : members && members.length > 0 ? (
				<SettingsTableFrame
					footer={
						<>
							<span className="tabular-nums">
								{members.length} {members.length === 1 ? "member" : "members"}
								{" · "}
								{adminCount} {adminCount === 1 ? "admin" : "admins"}
							</span>
							{currentUserMember ? (
								<span>
									Your role:{" "}
									<span className="text-foreground">
										{ROLE_LABELS[currentUserMember.role]}
									</span>
								</span>
							) : null}
						</>
					}
				>
					<Table>
						<caption className="sr-only">Team members</caption>
						<TableHeader>
							<TableRow>
								<TableHead>Member</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Joined</TableHead>
								<TableHead className="text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{members.map((member) => {
								const isCurrentUser = member.userId === user?.id;
								const displayName =
									member.user?.name ||
									(isCurrentUser ? user?.name : undefined) ||
									"Unknown User";
								const displayEmail =
									member.user?.email ||
									(isCurrentUser ? user?.email : undefined) ||
									member.userId;

								return (
									<TableRow key={member.id}>
										<TableCell>
											<div className="flex items-center gap-3">
												<Avatar className="h-8 w-8">
													<AvatarFallback className="text-xs">
														{getInitials(displayName, displayEmail)}
													</AvatarFallback>
												</Avatar>
												<div>
													<div className="font-medium">
														{displayName}
														{isCurrentUser && (
															<span className="ml-2 text-xs text-muted-foreground">
																(you)
															</span>
														)}
													</div>
													<div className="text-sm text-muted-foreground">
														{displayEmail}
													</div>
												</div>
											</div>
										</TableCell>
										<TableCell>
											<div className="flex flex-col items-start gap-1">
												<div className="flex flex-wrap items-center gap-1">
													{getRoleBadge(member.role)}
													{member.emergencyAccess && (
														<Badge
															variant="outline"
															title="Keeps password sign-in when single sign-on is required. Directory sync cannot remove them."
														>
															<LifeBuoy className="mr-1 h-3 w-3" />
															Emergency access
														</Badge>
													)}
												</div>
												{(member.environmentRoles ?? []).map((grant) => (
													<span
														key={grant.environmentId}
														className="text-xs text-muted-foreground"
													>
														{environmentName(grant.environmentId)}:{" "}
														{ROLE_LABELS[grant.role]}
													</span>
												))}
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground">
											{member.joinedAt ? (
												<RelativeTime value={member.joinedAt} />
											) : null}
										</TableCell>
										<TableCell className="text-right">
											{member.userId !== user?.id && canManageMembers && (
												<DropdownMenu>
													<DropdownMenuTrigger
														render={
															<Button
																aria-label={`Actions for ${displayName}`}
																size="icon"
																variant="ghost"
															/>
														}
													>
														<MoreHorizontal
															aria-hidden="true"
															className="h-4 w-4"
														/>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														{!member.emergencyAccess && (
															<DropdownMenuItem
																onClick={() => openRoleDialog(member)}
															>
																<Shield className="mr-2 h-4 w-4" />
																Change role
															</DropdownMenuItem>
														)}
														{environmentRolesEnabled &&
															!member.emergencyAccess && (
																<DropdownMenuItem
																	onClick={() => openEnvRolesDialog(member)}
																>
																	<Layers className="mr-2 h-4 w-4" />
																	Environment roles
																</DropdownMenuItem>
															)}
														{hasEmergencyAccess && member.role === "admin" && (
															<DropdownMenuItem
																onClick={() => openEmergencyDialog(member)}
															>
																<KeyRound className="mr-2 h-4 w-4" />
																{member.emergencyAccess
																	? "Remove emergency access"
																	: "Give emergency access"}
															</DropdownMenuItem>
														)}
														{!member.emergencyAccess && (
															<>
																<DropdownMenuSeparator />
																<DropdownMenuItem
																	onClick={() => openRemoveDialog(member)}
																	className="text-destructive focus:text-destructive"
																>
																	<UserMinus className="mr-2 h-4 w-4" />
																	Remove member
																</DropdownMenuItem>
															</>
														)}
													</DropdownMenuContent>
												</DropdownMenu>
											)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</SettingsTableFrame>
			) : (
				<SettingsTableFrame>
					<ListEmpty>No team members.</ListEmpty>
				</SettingsTableFrame>
			)}

			{canManageMembers && pendingInvitations.length > 0 && (
				<SettingsSection
					title="Pending invitations"
					description="Invitations waiting for acceptance."
					flush
				>
					<SettingsTableFrame>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Email</TableHead>
									<TableHead>Role</TableHead>
									<TableHead>Sent</TableHead>
									<TableHead>Expires</TableHead>
									<TableHead className="text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{pendingInvitations.map((invitation) => (
									<TableRow key={invitation.id}>
										<TableCell>
											<div className="flex items-center gap-3">
												<Avatar className="h-8 w-8">
													<AvatarFallback className="text-xs bg-muted">
														<Mail className="h-4 w-4" />
													</AvatarFallback>
												</Avatar>
												<div>
													<div className="font-medium">{invitation.email}</div>
													<div className="text-xs text-muted-foreground flex items-center gap-1">
														<Clock className="h-3 w-3" />
														Pending acceptance
													</div>
												</div>
											</div>
										</TableCell>
										<TableCell>
											{getRoleBadge(invitation.role as Role)}
										</TableCell>
										<TableCell className="text-muted-foreground">
											<RelativeTime value={invitation.createdAt} />
										</TableCell>
										<TableCell className="text-muted-foreground">
											<RelativeTime value={invitation.expiresAt} />
										</TableCell>
										<TableCell className="text-right">
											<div className="flex items-center justify-end gap-2">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => handleResendInvitation(invitation)}
													disabled={resendInvitation.isPending}
												>
													<Send className="h-4 w-4 mr-1" />
													Resend
												</Button>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => handleCancelInvitation(invitation)}
													disabled={cancelInvitation.isPending}
													className="text-destructive hover:text-destructive"
												>
													<X className="h-4 w-4 mr-1" />
													Cancel
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</SettingsTableFrame>
				</SettingsSection>
			)}

			{!isLastAdmin && (
				<SettingsSection variant="danger" title="Danger zone">
					<SettingsRow
						label="Leave this workspace"
						description="You lose access to its resources, and the API keys you created here are revoked."
					>
						<Button
							variant="destructive"
							size="sm"
							onClick={() => setIsLeaveDialogOpen(true)}
						>
							Leave workspace
						</Button>
					</SettingsRow>
				</SettingsSection>
			)}

			<Dialog open={isInviteDialogOpen} onOpenChange={setIsInviteDialogOpen}>
				<DialogPopup className="sm:max-w-sm">
					<Form className="contents">
						<DialogHeader>
							<DialogTitle>Invite team member</DialogTitle>
							<DialogDescription>
								Invite a new member to join {currentWorkspace?.name}.
							</DialogDescription>
						</DialogHeader>
						<DialogPanel className="grid gap-4">
							<Field>
								<FieldLabel htmlFor="email">Email address</FieldLabel>
								<Input
									id="email"
									type="email"
									placeholder="colleague@company.com"
									value={inviteEmail}
									onChange={(e) => setInviteEmail(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="role">Role</FieldLabel>
								<Select
									value={inviteRole}
									onValueChange={(value) => {
										if (value) setInviteRole(value as AssignableRole);
									}}
								>
									<SelectTrigger id="role">
										<SelectValue />
									</SelectTrigger>
									<SelectPopup>{roleOptions}</SelectPopup>
								</Select>
							</Field>
						</DialogPanel>
						<DialogFooter>
							<DialogClose
								render={<Button variant="ghost" />}
								onClick={() => {
									setInviteEmail("");
									setInviteRole("member");
								}}
							>
								Cancel
							</DialogClose>
							<Button
								onClick={handleInviteMember}
								disabled={!inviteEmail.trim()}
								loading={createInvitation.isPending}
							>
								Send invite
							</Button>
						</DialogFooter>
					</Form>
				</DialogPopup>
			</Dialog>

			<Dialog
				open={inviteLink !== null}
				onOpenChange={(open) => {
					if (!open) setInviteLink(null);
				}}
			>
				<DialogPopup className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Send this link to {inviteLink?.email}</DialogTitle>
						<DialogDescription>
							This server does not send email, so the invitation was not
							emailed. Anyone with the link can join as this person until it
							expires in seven days. It is shown only now; resend the invitation
							for a new one.
						</DialogDescription>
					</DialogHeader>
					<DialogPanel>
						<Input
							readOnly
							value={inviteLink?.url ?? ""}
							aria-label="Invitation link"
							onFocus={(event) => event.currentTarget.select()}
						/>
					</DialogPanel>
					<DialogFooter>
						<DialogClose render={<Button variant="ghost" />}>Done</DialogClose>
						<Button
							onClick={async () => {
								if (!inviteLink) return;
								await navigator.clipboard.writeText(inviteLink.url);
								toastManager.add({ title: "Link copied", type: "success" });
							}}
						>
							Copy link
						</Button>
					</DialogFooter>
				</DialogPopup>
			</Dialog>

			<Dialog open={isRoleDialogOpen} onOpenChange={setIsRoleDialogOpen}>
				<DialogPopup className="sm:max-w-sm">
					<Form className="contents">
						<DialogHeader>
							<DialogTitle>Change member role</DialogTitle>
							<DialogDescription>
								Update the role for{" "}
								{selectedMember?.user?.name || selectedMember?.user?.email}.
							</DialogDescription>
						</DialogHeader>
						<DialogPanel className="grid gap-4">
							<Field>
								<FieldLabel htmlFor="new-role">New role</FieldLabel>
								<Select
									value={newRole}
									onValueChange={(value) => {
										if (value) setNewRole(value as AssignableRole);
									}}
								>
									<SelectTrigger id="new-role">
										<SelectValue />
									</SelectTrigger>
									<SelectPopup>{roleOptions}</SelectPopup>
								</Select>
							</Field>
						</DialogPanel>
						<DialogFooter>
							<DialogClose render={<Button variant="ghost" />}>
								Cancel
							</DialogClose>
							<Button
								onClick={handleUpdateRole}
								loading={updateMemberRole.isPending}
							>
								Update role
							</Button>
						</DialogFooter>
					</Form>
				</DialogPopup>
			</Dialog>

			{environmentRolesEnabled && currentWorkspace?.id && (
				<EnvironmentRolesDialog
					open={isEnvRolesDialogOpen}
					onOpenChange={setIsEnvRolesDialogOpen}
					workspaceId={currentWorkspace.id}
					member={
						members?.find((m) => m.userId === selectedMember?.userId) ?? null
					}
					environments={environments}
				/>
			)}

			<AlertDialog
				open={isRemoveDialogOpen}
				onOpenChange={setIsRemoveDialogOpen}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Remove{" "}
							{selectedMember?.user?.name ||
								selectedMember?.user?.email ||
								"this member"}
							?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Remove{" "}
							<strong>
								{selectedMember?.user?.name || selectedMember?.user?.email}
							</strong>{" "}
							from this workspace. They lose access to all resources, the API
							keys they created here are revoked (agents using them stop working
							at once), and apps they connected to this workspace are
							disconnected.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							render={
								<Button
									variant="destructive"
									loading={removeMember.isPending}
								/>
							}
							onClick={handleRemoveMember}
						>
							Remove member
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<AlertDialog open={isLeaveDialogOpen} onOpenChange={setIsLeaveDialogOpen}>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Leave {currentWorkspace?.name ?? "this workspace"}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Leave <strong>{currentWorkspace?.name}</strong>. You lose access
							to all resources and need to be reinvited.{" "}
							<strong>
								Every API key you created in this workspace is revoked
							</strong>
							, so agents and integrations using those keys stop working at
							once, and apps you connected to this workspace are disconnected.
							Replace those keys first if anything still depends on them.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose render={<Button variant="ghost" />}>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							render={
								<Button
									variant="destructive"
									loading={leaveWorkspace.isPending}
								/>
							}
							onClick={handleLeaveWorkspace}
						>
							Leave workspace
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>

			<AlertDialog
				open={isEmergencyDialogOpen}
				onOpenChange={setIsEmergencyDialogOpen}
			>
				<AlertDialogPopup>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{emergencyEnabling
								? `Give ${emergencyTargetName} emergency access?`
								: `Remove ${emergencyTargetName}'s emergency access?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{emergencyEnabling
								? "They can sign in with a password and two-factor when single sign-on is required, and directory sync cannot remove them. Use it for the one or two people who must reach the workspace if the identity provider fails. At most two admins have it."
								: "They will sign in through single sign-on like everyone else when it is required, and directory sync can manage them. At least one admin keeps emergency access."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogClose
							render={<Button variant="ghost" />}
							onClick={() => setEmergencyTarget(null)}
						>
							Cancel
						</AlertDialogClose>
						<AlertDialogClose
							render={
								<Button
									variant={emergencyEnabling ? "default" : "destructive"}
									loading={setEmergencyAccess.isPending}
								/>
							}
							onClick={handleSetEmergencyAccess}
						>
							{emergencyEnabling
								? "Give emergency access"
								: "Remove emergency access"}
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogPopup>
			</AlertDialog>
		</SettingsPage>
	);
}
