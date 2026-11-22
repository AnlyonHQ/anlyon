import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { TeamPlanNotice } from "@/components/plan/team-plan-notice";
import {
	ConfirmAction,
	CopyValue,
	EnterpriseOnly,
	RoleSelect,
} from "@/components/settings/identity-shared";
import {
	LearnMore,
	SettingsPage,
	SettingsRow,
	SettingsSection,
} from "@/components/settings/settings-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspace } from "@/contexts/workspace-context";
import {
	type CreateSsoConnectionInput,
	isEnforcementSuspended,
	isUnavailable,
	type SsoConnection,
	useCreateSsoConnection,
	useDeleteSsoConnection,
	useSsoConnection,
	useUpdateSsoConnection,
	useVerifySsoDomains,
} from "@/hooks/api/use-identity";
import { useWorkspaceMembers } from "@/hooks/api/use-workspaces";
import { useAuth } from "@/hooks/use-auth";
import { usePlanAccess } from "@/hooks/use-plan-access";

export const Route = createFileRoute("/_protected/settings/sso")({
	component: SsoSettingsPage,
});

function SsoSettingsPage() {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id ?? "";
	const { user } = useAuth();
	const { data: members } = useWorkspaceMembers(workspaceId);
	const me = members?.find((m) => m.userId === user?.id);
	const hasEmergencyAccess = me?.emergencyAccess === true;
	const isAdmin = me?.role === "admin";
	const { data: connection, isLoading, error } = useSsoConnection(workspaceId);
	const { teamPlanRequired } = usePlanAccess(workspaceId);

	return (
		<SettingsPage
			title="Single sign-on"
			description="Members sign in through your company's identity provider (OIDC or SAML), found from their email domain."
		>
			{isUnavailable(error) ? (
				<div className="flex flex-col gap-3">
					{isEnforcementSuspended(error) ? (
						<Alert variant="warning">
							<AlertTitle>Single sign-on is no longer required</AlertTitle>
							<AlertDescription>
								This workspace required single sign-on, but this deployment's
								edition does not include it. Members can sign in with a password
								or social login again until the edition includes single sign-on.
							</AlertDescription>
						</Alert>
					) : null}
					<EnterpriseOnly feature="Single sign-on" />
				</div>
			) : isLoading ? (
				<Skeleton className="h-40 w-full" />
			) : !isAdmin ? (
				<p className="text-muted-foreground text-sm">
					Only workspace admins can view or change single sign-on.
				</p>
			) : (
				<>
					<TeamPlanNotice
						feature="Single sign-on"
						hasConfiguration={!!connection}
					/>
					{connection ? (
						<ConnectionSettings
							workspaceId={workspaceId}
							connection={connection}
							hasEmergencyAccess={hasEmergencyAccess}
						/>
					) : teamPlanRequired ? null : (
						<CreateConnection workspaceId={workspaceId} />
					)}
				</>
			)}
		</SettingsPage>
	);
}

function splitDomains(value: string): string[] {
	return value
		.split(/[\s,]+/)
		.map((d) => d.trim())
		.filter(Boolean);
}

function CreateConnection({ workspaceId }: { workspaceId: string }) {
	const create = useCreateSsoConnection(workspaceId);
	const uid = useId();
	const fid = (name: string) => `${uid}-${name}`;
	const [protocol, setProtocol] = useState<"oidc" | "saml">("oidc");
	const [domains, setDomains] = useState("");
	const [defaultRole, setDefaultRole] = useState("member");
	const [oidc, setOidc] = useState({
		issuer: "",
		clientId: "",
		clientSecret: "",
	});
	const [saml, setSaml] = useState({
		entityId: "",
		ssoUrl: "",
		certificate: "",
		emailAttribute: "",
		nameAttribute: "",
	});

	const submit = () => {
		const base = { domains: splitDomains(domains), defaultRole };
		const input: CreateSsoConnectionInput =
			protocol === "oidc"
				? { protocol, ...base, oidc }
				: {
						protocol,
						...base,
						saml: {
							entityId: saml.entityId,
							ssoUrl: saml.ssoUrl,
							certificate: saml.certificate,
							emailAttribute: saml.emailAttribute || undefined,
							nameAttribute: saml.nameAttribute || undefined,
						},
					};
		create.mutate(input);
	};

	const ready =
		splitDomains(domains).length > 0 &&
		(protocol === "oidc"
			? oidc.issuer && oidc.clientId && oidc.clientSecret
			: saml.entityId && saml.ssoUrl && saml.certificate);

	return (
		<SettingsSection
			title="Connect an identity provider"
			description={
				<>
					Enter the details of the app you created for Anlyon in your identity
					provider.{" "}
					<LearnMore href="https://docs.anlyon.com/account/sso-scim#connect-an-identity-provider" />
				</>
			}
			footer={
				<Button
					size="sm"
					disabled={!ready || create.isPending}
					loading={create.isPending}
					onClick={submit}
				>
					Save identity provider
				</Button>
			}
		>
			<div className="flex flex-col gap-4">
				<SegmentedControl
					label="Protocol"
					value={protocol}
					onChange={setProtocol}
					options={[
						{ value: "oidc", label: "OIDC" },
						{ value: "saml", label: "SAML" },
					]}
				/>
				<Field>
					<FieldLabel htmlFor={fid("sso-domains")}>Email domains</FieldLabel>
					<Input
						id={fid("sso-domains")}
						placeholder="acme.com, acme.io"
						value={domains}
						onChange={(e) => setDomains(e.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						People with an address on these domains sign in through this
						provider. You prove each domain with a DNS record.
					</p>
				</Field>
				{protocol === "oidc" ? (
					<>
						<Field>
							<FieldLabel htmlFor={fid("oidc-issuer")}>Issuer URL</FieldLabel>
							<Input
								id={fid("oidc-issuer")}
								placeholder="https://acme.okta.com"
								value={oidc.issuer}
								onChange={(e) => setOidc({ ...oidc, issuer: e.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={fid("oidc-client-id")}>Client ID</FieldLabel>
							<Input
								id={fid("oidc-client-id")}
								value={oidc.clientId}
								onChange={(e) => setOidc({ ...oidc, clientId: e.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={fid("oidc-client-secret")}>
								Client secret
							</FieldLabel>
							<Input
								id={fid("oidc-client-secret")}
								type="password"
								autoComplete="off"
								value={oidc.clientSecret}
								onChange={(e) =>
									setOidc({ ...oidc, clientSecret: e.target.value })
								}
							/>
						</Field>
					</>
				) : (
					<>
						<Field>
							<FieldLabel htmlFor={fid("saml-entity")}>
								Identity provider entity ID (issuer)
							</FieldLabel>
							<Input
								id={fid("saml-entity")}
								placeholder="http://www.okta.com/exk"
								value={saml.entityId}
								onChange={(e) => setSaml({ ...saml, entityId: e.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={fid("saml-sso-url")}>
								Single sign-on URL
							</FieldLabel>
							<Input
								id={fid("saml-sso-url")}
								placeholder="https://acme.okta.com/app/.../sso/saml"
								value={saml.ssoUrl}
								onChange={(e) => setSaml({ ...saml, ssoUrl: e.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={fid("saml-cert")}>
								Signing certificate
							</FieldLabel>
							<Textarea
								id={fid("saml-cert")}
								rows={5}
								placeholder="-----BEGIN CERTIFICATE-----"
								value={saml.certificate}
								onChange={(e) =>
									setSaml({ ...saml, certificate: e.target.value })
								}
							/>
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor={fid("saml-email-attr")}>
									Email attribute (optional)
								</FieldLabel>
								<Input
									id={fid("saml-email-attr")}
									placeholder="email"
									value={saml.emailAttribute}
									onChange={(e) =>
										setSaml({ ...saml, emailAttribute: e.target.value })
									}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={fid("saml-name-attr")}>
									Name attribute (optional)
								</FieldLabel>
								<Input
									id={fid("saml-name-attr")}
									placeholder="displayName"
									value={saml.nameAttribute}
									onChange={(e) =>
										setSaml({ ...saml, nameAttribute: e.target.value })
									}
								/>
							</Field>
						</div>
					</>
				)}
				<Field>
					<FieldLabel htmlFor={fid("sso-default-role")}>
						Role for a first sign-in
					</FieldLabel>
					<RoleSelect
						id={fid("sso-default-role")}
						value={defaultRole}
						onChange={setDefaultRole}
					/>
					<p className="text-xs text-muted-foreground">
						Someone who signs in through the provider for the first time joins
						with this role. With a SCIM directory connected, the directory
						decides membership instead.
					</p>
				</Field>
			</div>
		</SettingsSection>
	);
}

function ConnectionSettings({
	workspaceId,
	connection,
	hasEmergencyAccess,
}: {
	workspaceId: string;
	connection: SsoConnection;
	hasEmergencyAccess: boolean;
}) {
	const verify = useVerifySsoDomains(workspaceId);
	const update = useUpdateSsoConnection(workspaceId);
	const remove = useDeleteSsoConnection(workspaceId);
	const sp = connection.serviceProvider;

	return (
		<>
			<SettingsSection
				title="Identity provider"
				description={`${connection.protocol.toUpperCase()} · ${connection.issuer}`}
			>
				<div className="flex flex-col gap-3">
					<p className="text-sm text-muted-foreground">
						Enter these values in your identity provider's app for Anlyon.
					</p>
					{sp.oidcRedirectUri ? (
						<CopyValue label="Redirect URI" value={sp.oidcRedirectUri} />
					) : null}
					{sp.samlAcsUrl ? (
						<CopyValue label="ACS URL" value={sp.samlAcsUrl} />
					) : null}
					{sp.samlEntityId ? (
						<CopyValue label="Entity ID (audience)" value={sp.samlEntityId} />
					) : null}
					{sp.samlMetadataUrl ? (
						<CopyValue label="Metadata URL" value={sp.samlMetadataUrl} />
					) : null}
				</div>
			</SettingsSection>

			<SettingsSection
				title="Domains"
				description={
					<>
						Add a TXT record for each domain, then verify. Sign-in starts once
						every domain is verified.{" "}
						<LearnMore href="https://docs.anlyon.com/account/sso-scim#verify-your-domains" />
					</>
				}
				footer={
					connection.domainsVerified ? null : (
						<Button
							size="sm"
							loading={verify.isPending}
							disabled={verify.isPending}
							onClick={() => verify.mutate(undefined)}
						>
							Verify domains
						</Button>
					)
				}
			>
				<div className="flex flex-col gap-4">
					{connection.verificationRecords.map((record) => (
						<div key={record.domain} className="flex flex-col gap-2">
							<div className="flex items-center gap-2">
								<span className="text-sm font-medium">{record.domain}</span>
								<Badge
									variant={connection.domainsVerified ? "success" : "warning"}
								>
									{connection.domainsVerified ? "Verified" : "Not verified"}
								</Badge>
							</div>
							{connection.domainsVerified ? null : (
								<>
									<CopyValue label="TXT record name" value={record.name} />
									<CopyValue label="TXT record value" value={record.value} />
								</>
							)}
						</div>
					))}
				</div>
			</SettingsSection>

			<SettingsSection title="Sign-in">
				<div className="divide-y divide-border/70">
					<SettingsRow
						label="Require single sign-on"
						description={
							<>
								Members must sign in through this provider. Admins with
								emergency access are exempt.{" "}
								{!hasEmergencyAccess
									? "Only an admin with emergency access can change this. "
									: !connection.domainsVerified
										? "Verify the domains first. "
										: null}
								<LearnMore href="https://docs.anlyon.com/account/sso-scim#require-single-sign-on" />
							</>
						}
					>
						<span className="text-muted-foreground text-sm">
							{connection.enforced ? "Required" : "Optional"}
						</span>
						<Switch
							checked={connection.enforced}
							disabled={
								!hasEmergencyAccess ||
								!connection.domainsVerified ||
								update.isPending
							}
							onCheckedChange={(checked) =>
								update.mutate({ enforced: checked })
							}
							aria-label="Require single sign-on"
						/>
					</SettingsRow>
					<SettingsRow
						label="Role for a first sign-in"
						description="The role a person gets when they join through the provider. A connected directory sets roles instead."
					>
						<RoleSelect
							value={connection.defaultRole}
							disabled={update.isPending}
							onChange={(role) => update.mutate({ defaultRole: role })}
						/>
					</SettingsRow>
				</div>
			</SettingsSection>

			<SettingsSection title="Danger zone" variant="danger">
				<SettingsRow
					label="Remove identity provider"
					description="Members can no longer sign in through it. Requiring single sign-on ends with it."
				>
					<ConfirmAction
						title="Remove the identity provider?"
						description="Members who have no password or social login will not be able to sign in until a provider is added again."
						confirmLabel="Remove"
						pending={remove.isPending}
						onConfirm={() => remove.mutate(undefined)}
						trigger={(open) => (
							<Button
								size="sm"
								variant="destructive"
								disabled={connection.enforced && !hasEmergencyAccess}
								onClick={open}
							>
								Remove
							</Button>
						)}
					/>
				</SettingsRow>
			</SettingsSection>
		</>
	);
}
