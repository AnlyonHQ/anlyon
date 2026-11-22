import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	AlertTriangle,
	Building2,
	CheckCircle,
	Clock,
	Eye,
	Gavel,
	LogIn,
	Mail,
	Shield,
	ShieldCheck,
	Users,
	XCircle,
} from "lucide-react";
import { useEffect } from "react";
import { AppLogo } from "@/components/logo/app-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import {
	useAcceptInvitation,
	useDeclineInvitation,
	useInvitationByToken,
} from "@/hooks/api/use-workspaces";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/invite/$token")({
	component: InvitePage,
});

function InvitePage() {
	const { token } = Route.useParams();
	const navigate = useNavigate();
	const {
		isAuthenticated,
		user,
		isLoading: authLoading,
		refetch: refetchAuth,
	} = useAuth();

	const {
		data: invitation,
		isLoading,
		error,
		refetch: refetchInvitation,
	} = useInvitationByToken(token);
	const acceptInvitation = useAcceptInvitation();
	const declineInvitation = useDeclineInvitation();

	useEffect(() => {
		refetchAuth();
	}, [refetchAuth]);

	const needsEmailVerification = isAuthenticated && user && !user.emailVerified;

	const handleAccept = async () => {
		try {
			await acceptInvitation.mutateAsync(token);
			toast.success(`Welcome to ${invitation?.workspace.name}!`, {
				description: "You've successfully joined the workspace.",
			});
			navigate({ to: "/dashboard" });
		} catch {
		}
	};

	const handleDecline = async () => {
		try {
			await declineInvitation.mutateAsync(token);
			toast.info("Invitation declined");
			navigate({ to: "/" });
		} catch {
		}
	};

	const getRoleBadge = (role: string) => {
		switch (role) {
			case "admin":
				return (
					<Badge variant="default" className="bg-blue-500">
						<ShieldCheck className="mr-1 h-3 w-3" />
						Admin
					</Badge>
				);
			case "approver":
				return (
					<Badge variant="secondary">
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
			default:
				return (
					<Badge variant="secondary">
						<Shield className="mr-1 h-3 w-3" />
						Member
					</Badge>
				);
		}
	};

	if (isLoading || authLoading) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-background p-4">
				<Frame className="w-full max-w-md">
					<FrameHeader className="text-center">
						<Skeleton className="h-12 w-12 rounded-full mx-auto" />
						<Skeleton className="h-6 w-48 mx-auto mt-4" />
						<Skeleton className="h-4 w-64 mx-auto mt-2" />
					</FrameHeader>
					<FramePanel className="space-y-4">
						<Skeleton className="h-20 w-full" />
						<div className="flex gap-3">
							<Skeleton className="h-10 flex-1" />
							<Skeleton className="h-10 flex-1" />
						</div>
					</FramePanel>
				</Frame>
			</div>
		);
	}

	if (error || !invitation) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-background p-4">
				<Frame className="w-full max-w-md">
					<FrameHeader className="text-center">
						<div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
							<AlertTriangle className="h-6 w-6 text-destructive" />
						</div>
						<FrameTitle>Invitation Not Found</FrameTitle>
						<FrameDescription>
							This invitation link is invalid or has expired.
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="text-center">
						<p className="text-sm text-muted-foreground mb-6">
							Please contact the workspace admin to request a new invitation.
						</p>
						<Link to="/">
							<Button variant="outline" className="w-full">
								Go to Home
							</Button>
						</Link>
					</FramePanel>
				</Frame>
			</div>
		);
	}

	if (
		invitation.status === "expired" ||
		new Date(invitation.expiresAt) < new Date()
	) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-background p-4">
				<Frame className="w-full max-w-md">
					<FrameHeader className="text-center">
						<div className="mx-auto w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center mb-4">
							<Clock className="h-6 w-6 text-amber-500" />
						</div>
						<FrameTitle>Invitation Expired</FrameTitle>
						<FrameDescription>
							This invitation to join{" "}
							<strong>{invitation.workspace.name}</strong> has expired.
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="text-center">
						<p className="text-sm text-muted-foreground mb-6">
							Please contact the workspace admin to request a new invitation.
						</p>
						<Link to="/">
							<Button variant="outline" className="w-full">
								Go to Home
							</Button>
						</Link>
					</FramePanel>
				</Frame>
			</div>
		);
	}

	if (invitation.status !== "pending") {
		return (
			<div className="min-h-screen flex items-center justify-center bg-background p-4">
				<Frame className="w-full max-w-md">
					<FrameHeader className="text-center">
						<div
							className={`mx-auto w-12 h-12 rounded-full flex items-center justify-center mb-4 ${
								invitation.status === "accepted"
									? "bg-green-500/10"
									: "bg-muted"
							}`}
						>
							{invitation.status === "accepted" ? (
								<CheckCircle className="h-6 w-6 text-green-500" />
							) : (
								<XCircle className="h-6 w-6 text-muted-foreground" />
							)}
						</div>
						<FrameTitle>
							{invitation.status === "accepted"
								? "Already Accepted"
								: "Invitation " +
									invitation.status.charAt(0).toUpperCase() +
									invitation.status.slice(1)}
						</FrameTitle>
						<FrameDescription>
							{invitation.status === "accepted"
								? `You're already a member of ${invitation.workspace.name}`
								: `This invitation has been ${invitation.status}`}
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="text-center">
						<Link to={invitation.status === "accepted" ? "/dashboard" : "/"}>
							<Button className="w-full">
								{invitation.status === "accepted"
									? "Go to Dashboard"
									: "Go to Home"}
							</Button>
						</Link>
					</FramePanel>
				</Frame>
			</div>
		);
	}

	if (needsEmailVerification) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-background p-4">
				<Frame className="w-full max-w-md">
					<FrameHeader className="text-center">
						<div className="mx-auto w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center mb-4">
							<Mail className="h-6 w-6 text-blue-500" />
						</div>
						<FrameTitle>Verify Your Email</FrameTitle>
						<FrameDescription>
							Please verify your email address to accept this invitation.
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="space-y-6">
						<div className="rounded-lg border p-4 space-y-3">
							<div className="flex items-center gap-3">
								<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
									<Building2 className="h-5 w-5 text-muted-foreground" />
								</div>
								<div>
									<p className="font-medium">{invitation.workspace.name}</p>
									<p className="text-sm text-muted-foreground">
										Invited by{" "}
										{invitation.invitedBy?.name ||
											invitation.invitedBy?.email ||
											"a team member"}
									</p>
								</div>
							</div>
						</div>

						<div className="text-center space-y-2">
							<p className="text-sm text-muted-foreground">
								We sent a verification email to <strong>{user?.email}</strong>
							</p>
							<p className="text-xs text-muted-foreground">
								Click the link in your email to verify your account, then return
								here to accept the invitation.
							</p>
						</div>

						<Button
							variant="outline"
							className="w-full"
							onClick={() => {
								refetchAuth();
								refetchInvitation();
								toast.info("Checking verification status...");
							}}
						>
							I've Verified My Email
						</Button>
					</FramePanel>
				</Frame>
			</div>
		);
	}

	if (!isAuthenticated) {
		const loginUrl = `/auth/login?redirect=/invite/${token}`;
		const signupUrl = `/auth/signup?redirect=/invite/${token}&email=${encodeURIComponent(invitation.email)}`;

		return (
			<div className="min-h-screen flex items-center justify-center bg-background p-4">
				<Frame className="w-full max-w-md">
					<FrameHeader className="text-center">
						<div className="flex items-center justify-center mb-4">
							<AppLogo size={32} />
						</div>
						<FrameTitle>You're Invited!</FrameTitle>
						<FrameDescription>
							Sign in or create an account to join{" "}
							<strong>{invitation.workspace.name}</strong>
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="space-y-6">
						<div className="rounded-lg border p-4 space-y-3">
							<div className="flex items-center gap-3">
								<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
									<Building2 className="h-5 w-5 text-muted-foreground" />
								</div>
								<div>
									<p className="font-medium">{invitation.workspace.name}</p>
									<p className="text-sm text-muted-foreground">
										Invited by{" "}
										{invitation.invitedBy?.name ||
											invitation.invitedBy?.email ||
											"a team member"}
									</p>
								</div>
							</div>
							<div className="flex items-center justify-between text-sm">
								<span className="text-muted-foreground">Your role:</span>
								{getRoleBadge(invitation.role)}
							</div>
							<div className="flex items-center justify-between text-sm">
								<span className="text-muted-foreground">Invited email:</span>
								<span className="font-mono text-xs">{invitation.email}</span>
							</div>
						</div>

						<div className="space-y-3 flex flex-row gap-2 w-full justify-center">
							<Link to={signupUrl}>
								<Button className="w-full">Create Account</Button>
							</Link>
							<Link to={loginUrl}>
								<Button variant="ghost" className="w-full">
									<LogIn className="mr-2 h-4 w-4" />
									Sign In
								</Button>
							</Link>
						</div>

						<p className="text-xs text-center text-muted-foreground">
							By accepting this invitation, you'll join{" "}
							{invitation.workspace.name} and have access to its resources.
						</p>
					</FramePanel>
				</Frame>
			</div>
		);
	}

	const emailMismatch =
		user?.email?.toLowerCase() !== invitation.email.toLowerCase();

	return (
		<div className="min-h-screen flex items-center justify-center bg-background p-4">
			<Frame className="w-full max-w-md">
				<FrameHeader className="text-center">
					<div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
						<Users className="h-6 w-6 text-primary" />
					</div>
					<FrameTitle>Join {invitation.workspace.name}</FrameTitle>
					<FrameDescription>
						{invitation.invitedBy?.name ||
							invitation.invitedBy?.email ||
							"A team member"}{" "}
						has invited you to join their workspace
					</FrameDescription>
				</FrameHeader>
				<FramePanel className="space-y-6">
					{emailMismatch && (
						<div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/50 p-3">
							<div className="flex items-start gap-2">
								<AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
								<div className="text-sm text-amber-800 dark:text-amber-200">
									<p className="font-medium">Email mismatch</p>
									<p className="mt-1">
										This invitation was sent to{" "}
										<strong>{invitation.email}</strong>, but you're signed in as{" "}
										<strong>{user?.email}</strong>.
									</p>
								</div>
							</div>
						</div>
					)}

					<div className="rounded-lg border p-4 space-y-3">
						<div className="flex items-center gap-3">
							<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
								<Building2 className="h-5 w-5 text-muted-foreground" />
							</div>
							<div>
								<p className="font-medium">{invitation.workspace.name}</p>
								<p className="text-sm text-muted-foreground">
									Invited by{" "}
									{invitation.invitedBy?.name ||
										invitation.invitedBy?.email ||
										"a team member"}
								</p>
							</div>
						</div>
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Your role:</span>
							{getRoleBadge(invitation.role)}
						</div>
						<div className="flex items-center justify-between text-sm">
							<span className="text-muted-foreground">Expires:</span>
							<span>{new Date(invitation.expiresAt).toLocaleDateString()}</span>
						</div>
					</div>

					<div className="flex gap-3">
						<Button
							variant="outline"
							className="flex-1"
							onClick={handleDecline}
							disabled={
								declineInvitation.isPending || acceptInvitation.isPending
							}
						>
							{declineInvitation.isPending ? "Declining..." : "Decline"}
						</Button>
						<Button
							className="flex-1"
							onClick={handleAccept}
							disabled={
								acceptInvitation.isPending ||
								declineInvitation.isPending ||
								emailMismatch
							}
						>
							{acceptInvitation.isPending
								? "Accepting..."
								: "Accept Invitation"}
						</Button>
					</div>

					{emailMismatch && (
						<p className="text-xs text-center text-muted-foreground">
							Sign in with <strong>{invitation.email}</strong> to accept this
							invitation.
						</p>
					)}
				</FramePanel>
			</Frame>
		</div>
	);
}
