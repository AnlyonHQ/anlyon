import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { StepItem, StepList } from "@/components/first-run/steps";
import { Page, PageHeader } from "@/components/layout/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { useWorkspace } from "@/contexts/workspace-context";
import { usePutSecret, useSecrets } from "@/hooks/api/use-actions";
import {
	type McpInspection,
	useInspectMcpServer,
	useMcpUpstreams,
	useRegisterMcpUpstream,
} from "@/hooks/api/use-mcp-upstreams";
import { useCan } from "@/hooks/api/use-permissions";
import { ApiError } from "@/lib/api-client";
import { linkedServer, nameFromSlug } from "@/lib/mcp-server-link";
import {
	anlyonClientAvailable,
	type CredentialForm,
	normalizeServerUrl,
	type OAuthForm,
	oauthProblem,
	refusalHeadline,
	registration,
	type SecretChoice,
	secretNameFor,
	secretProblem,
	serverNameProblem,
	suggestName,
} from "@/lib/mcp-servers";
import { ContinueRow, CredentialSetup, OAuthSetup } from "./add-server-access";

type Access = "none" | "credential" | "oauth";

const describe = (error: unknown) =>
	error instanceof Error ? error.message : "Something went wrong.";

const toolCountText = (count: number) =>
	`${count} ${count === 1 ? "tool" : "tools"}`;

export function AddServerPage({ serverSlug }: { serverSlug?: string }) {
	const { currentWorkspace } = useWorkspace();
	const workspaceId = currentWorkspace?.id;
	const canManage = useCan(workspaceId)("actions.manage");
	return (
		<Page width="narrow">
			<PageHeader
				description="Anlyon reads what the server needs and walks you through it. Adding a server only lists its tools: your agent can call none of them until you choose."
				title="Add an MCP server"
			/>
			{canManage ? (
				<AddServerFlow serverSlug={serverSlug} workspaceId={workspaceId} />
			) : (
				<p className="text-muted-foreground text-sm">
					You need permission to manage actions to add a server. Ask a workspace
					admin.
				</p>
			)}
		</Page>
	);
}

export function AddServerFlow({
	workspaceId,
	serverSlug,
}: {
	workspaceId?: string;
	serverSlug?: string;
}) {
	const id = useId();
	const navigate = useNavigate();
	const upstreams = useMcpUpstreams(workspaceId);
	const taken = (upstreams.data ?? []).map((s) => s.name);
	const secrets = useSecrets(workspaceId).data ?? [];
	const inspect = useInspectMcpServer(workspaceId);
	const register = useRegisterMcpUpstream(workspaceId);
	const putSecret = usePutSecret();

	const [linked] = useState(() => linkedServer(serverSlug));
	const vendor = linked?.kind === "vendor" ? linked.vendor : null;
	const [urlText, setUrlText] = useState(vendor ? vendor.server.url : "");
	const [checked, setChecked] = useState<{
		url: string;
		result: Exclude<McpInspection, { kind: "refused" | "unreachable" }>;
	} | null>(null);
	const [problem, setProblem] = useState<{
		title: string;
		detail: string;
	} | null>(null);
	const [access, setAccess] = useState<Access>("none");
	const [accessDone, setAccessDone] = useState(false);
	const [credential, setCredential] = useState<CredentialForm>({
		secret: { mode: "new", name: "", value: "" },
		header: "bearer",
	});
	const [oauth, setOauth] = useState<OAuthForm>({
		clientId: "",
		secret: { mode: "new", name: "", value: "" },
		scopes: [],
	});
	const [name, setName] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);

	const result = checked?.result ?? null;
	const signIn =
		result && (result.kind === "oauth" || result.kind === "open")
			? result.signIn
			: null;
	const host = result?.host ?? "";

	const check = async () => {
		const url = normalizeServerUrl(urlText);
		if (!url) return;
		setProblem(null);
		setAddError(null);
		try {
			const answer = await inspect.mutateAsync(url);
			if (answer.kind === "refused") {
				setProblem({
					title: refusalHeadline(answer.reason),
					detail: answer.message,
				});
				return;
			}
			if (answer.kind === "unreachable") {
				setProblem({
					title: `Anlyon could not read ${answer.host} as an MCP server`,
					detail: `${answer.message} Check that this is the server's own endpoint, often ending in /mcp, and that it speaks Streamable HTTP.`,
				});
				return;
			}
			const suggested =
				vendor && url === vendor.server.url
					? nameFromSlug(vendor.slug, taken)
					: suggestName(url, taken);
			setUrlText(url);
			setChecked({ url, result: answer });
			setName(suggested);
			setCredential({
				secret: {
					mode: "new",
					name: secretNameFor(suggested, "MCP_TOKEN"),
					value: "",
				},
				header: "bearer",
			});
			const offered =
				answer.kind === "oauth" || answer.kind === "open"
					? answer.signIn
					: null;
			setOauth({
				anlyonClient: offered ? anlyonClientAvailable(offered) : false,
				clientId: "",
				secret: {
					mode: "new",
					name: secretNameFor(suggested, "CLIENT_SECRET"),
					value: "",
				},
				scopes: [],
			});
			if (answer.kind === "credential") {
				setAccess("credential");
				setAccessDone(false);
			} else if (answer.kind === "oauth" || answer.signIn) {
				setAccess("oauth");
				setAccessDone(false);
			} else {
				setAccess("none");
				setAccessDone(true);
			}
		} catch (error) {
			setProblem({
				title:
					error instanceof ApiError
						? "That address cannot be used"
						: "The check did not finish",
				detail: describe(error),
			});
		}
	};

	const autoChecked = useRef(false);
	const namesKnown = upstreams.data !== undefined || upstreams.isError;
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the names are known.
	useEffect(() => {
		if (!vendor || autoChecked.current || !workspaceId || !namesKnown) return;
		autoChecked.current = true;
		void check();
	}, [vendor, workspaceId, namesKnown]);

	const accessProblem =
		access === "credential"
			? secretProblem(credential.secret, secrets, host)
			: access === "oauth" && signIn
				? oauthProblem(oauth, signIn, secrets)
				: null;
	const nameProblem = serverNameProblem(name.trim(), taken);

	const storeSecret = async (
		secret: SecretChoice,
		allowedHost: string,
	): Promise<SecretChoice> => {
		if (secret.mode === "existing" || !workspaceId) return secret;
		await putSecret.mutateAsync({
			workspaceId,
			name: secret.name,
			value: secret.value,
			allowedHosts: [allowedHost],
		});
		return { mode: "existing", name: secret.name };
	};

	const add = async () => {
		if (!checked || nameProblem || accessProblem) return;
		setAddError(null);
		setAdding(true);
		try {
			let body: ReturnType<typeof registration>;
			if (access === "credential") {
				const secret = await storeSecret(credential.secret, host);
				const form = { ...credential, secret };
				setCredential(form);
				body = registration(name, checked.url, { kind: "credential", form });
			} else if (access === "oauth" && signIn) {
				const secret =
					oauth.secret && !oauth.anlyonClient
						? await storeSecret(oauth.secret, signIn.tokenHost)
						: oauth.secret;
				const form = { ...oauth, secret };
				setOauth(form);
				body = registration(name, checked.url, { kind: "oauth", form });
			} else {
				body = registration(name, checked.url, { kind: "none" });
			}
			const added = await register.mutateAsync(body);
			navigate({ to: "/mcp-servers/$name", params: { name: added.name } });
		} catch (error) {
			setAddError(describe(error));
		} finally {
			setAdding(false);
		}
	};

	const changeUrl = () => {
		setChecked(null);
		setAccessDone(false);
		setAddError(null);
	};

	const changeLink = (label: string, onClick: () => void) => (
		<Button onClick={onClick} size="xs" variant="ghost">
			{label}
		</Button>
	);

	return (
		<StepList>
			<StepItem
				doneAction={changeLink("Change", changeUrl)}
				line="Paste the server's address. Anlyon connects once, with no credential, to find out what it needs. Nothing is saved."
				number={1}
				result={result ? [host] : []}
				state={checked ? "done" : "active"}
				title="Where is the server?"
			>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						void check();
					}}
				>
					<div className="flex flex-wrap items-end gap-2">
						<div className="min-w-0 flex-1 basis-72 space-y-1.5">
							<Label htmlFor={`${id}-url`}>Server URL</Label>
							<Input
								autoCapitalize="none"
								autoComplete="off"
								className="font-mono"
								id={`${id}-url`}
								inputMode="url"
								onChange={(event) => {
									setUrlText(event.target.value);
									setProblem(null);
								}}
								placeholder="https://mcp.example.com/mcp"
								spellCheck={false}
								value={urlText}
							/>
						</div>
						<Button
							disabled={!urlText.trim()}
							loading={inspect.isPending}
							type="submit"
						>
							Check
						</Button>
					</div>
					{vendor && urlText === vendor.server.url && !problem ? (
						<p className="text-muted-foreground text-sm">
							{vendor.name}'s own MCP server, at{" "}
							<span className="font-medium font-mono text-foreground">
								{new URL(vendor.server.url).hostname}
							</span>
							, from Anlyon's checked list of vendors' servers. Review what it
							needs below. Nothing is added until you press Add server.
						</p>
					) : null}
					{linked?.kind === "unknown" && !urlText ? (
						<p className="text-muted-foreground text-sm">
							The link named a server that is not on Anlyon's list, so nothing
							was filled in. Paste the server's address yourself.
						</p>
					) : null}
					{problem ? (
						<Alert role="alert" variant="error">
							<AlertTitle>{problem.title}</AlertTitle>
							<AlertDescription>{problem.detail}</AlertDescription>
						</Alert>
					) : null}
				</form>
			</StepItem>

			<AccessStep
				access={access}
				accessDone={accessDone}
				accessProblem={accessProblem}
				credential={credential}
				host={host}
				name={name}
				oauth={oauth}
				onDone={() => setAccessDone(true)}
				reopen={() => setAccessDone(false)}
				result={result}
				secrets={secrets}
				setAccess={setAccess}
				setCredential={setCredential}
				setOauth={setOauth}
			/>

			<StepItem
				last
				line={`Each tool you adopt becomes an action called ${name.trim() || "name"}-<tool>. Adding the server lists its tools and adopts none of them.`}
				number={3}
				result={[]}
				state={accessDone ? "active" : "todo"}
				title="Name it"
			>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						void add();
					}}
				>
					<div className="flex flex-wrap items-end gap-2">
						<div className="min-w-0 flex-1 basis-60 space-y-1.5 sm:max-w-xs">
							<Label htmlFor={`${id}-name`}>Name</Label>
							<Input
								aria-describedby={`${id}-name-hint`}
								aria-invalid={nameProblem !== null || undefined}
								autoCapitalize="none"
								autoComplete="off"
								className="font-mono"
								id={`${id}-name`}
								maxLength={32}
								onChange={(event) => setName(event.target.value)}
								spellCheck={false}
								value={name}
							/>
						</div>
						<Button
							disabled={nameProblem !== null}
							loading={adding}
							type="submit"
						>
							Add server
						</Button>
					</div>
					<p
						className={
							nameProblem
								? "text-destructive text-xs"
								: "text-muted-foreground text-xs"
						}
						id={`${id}-name-hint`}
					>
						{nameProblem ?? "Lowercase letters, digits and hyphens."}
					</p>
					{addError ? (
						<Alert role="alert" variant="error">
							<AlertTitle>The server was not added</AlertTitle>
							<AlertDescription>{addError}</AlertDescription>
						</Alert>
					) : null}
				</form>
			</StepItem>
		</StepList>
	);
}

function AccessStep({
	result,
	host,
	access,
	setAccess,
	accessDone,
	accessProblem,
	onDone,
	reopen,
	credential,
	setCredential,
	oauth,
	setOauth,
	secrets,
	name,
}: {
	result: Exclude<McpInspection, { kind: "refused" | "unreachable" }> | null;
	host: string;
	access: Access;
	setAccess: (access: Access) => void;
	accessDone: boolean;
	accessProblem: string | null;
	onDone: () => void;
	reopen: () => void;
	credential: CredentialForm;
	setCredential: (form: CredentialForm) => void;
	oauth: OAuthForm;
	setOauth: (form: OAuthForm) => void;
	secrets: Parameters<typeof CredentialSetup>[0]["secrets"];
	name: string;
}) {
	const open = result?.kind === "open" ? result : null;
	const signIn =
		result?.kind === "credential" ? null : (result?.signIn ?? null);
	const summary =
		access === "credential"
			? ["Stored credential", credential.secret.name]
			: access === "oauth"
				? [
						"OAuth",
						oauth.anlyonClient ? "Anlyon's client" : oauth.clientId.trim(),
						`${oauth.scopes.length} scopes`,
					]
				: ["No sign-in", open ? toolCountText(open.toolCount) : ""];
	const title = !result
		? "How does it sign in?"
		: result.kind === "credential"
			? "Give it a credential"
			: result.kind === "oauth"
				? "Set up sign-in"
				: "How does it sign in?";
	const line = !result
		? ""
		: result.kind === "credential"
			? `${host} refused a request with no credential (HTTP ${result.status}) and does not offer OAuth, so it wants a key or token. It stays in the vault: your agent never holds it.`
			: result.kind === "oauth"
				? `${host} signs people in with OAuth, so each person's calls can carry their own token.${signIn && anlyonClientAvailable(signIn) ? "" : " That needs an OAuth app of your own at the vendor."}`
				: signIn
					? `${host} lists ${toolCountText(result.toolCount)} without a sign-in, and also offers OAuth for calling them. With OAuth, each person's calls carry their own token.`
					: `${host} lists ${toolCountText(result.toolCount)} without a sign-in.`;

	return (
		<StepItem
			doneAction={
				open && !open.signIn && access === "none" ? (
					<Button
						onClick={() => {
							setAccess("credential");
							reopen();
						}}
						size="xs"
						variant="ghost"
					>
						Needs a key to call its tools?
					</Button>
				) : (
					<Button onClick={reopen} size="xs" variant="ghost">
						Change
					</Button>
				)
			}
			line={line}
			number={2}
			result={summary.filter(Boolean)}
			state={!result ? "todo" : accessDone ? "done" : "active"}
			title={title}
		>
			<div className="flex flex-col gap-5">
				{open?.signIn ? (
					<RadioGroup
						aria-label="Sign-in for calls"
						className="gap-2"
						onValueChange={(value) => setAccess(value as Access)}
						value={access}
					>
						<Label className="flex items-center gap-2 font-normal">
							<Radio value="oauth" />
							Sign people in with OAuth
						</Label>
						<Label className="flex items-center gap-2 font-normal">
							<Radio value="none" />
							Call it without a sign-in
						</Label>
					</RadioGroup>
				) : null}
				{access === "oauth" && signIn ? (
					<OAuthSetup
						form={oauth}
						onChange={setOauth}
						secrets={secrets}
						serverName={name}
						signIn={signIn}
					/>
				) : null}
				{access === "credential" ? (
					<CredentialSetup
						form={credential}
						host={host}
						onChange={setCredential}
						secrets={secrets}
						serverName={name}
					/>
				) : null}
				<ContinueRow onContinue={onDone} problem={accessProblem}>
					{open && !open.signIn && access === "credential" ? (
						<Button
							onClick={() => {
								setAccess("none");
								onDone();
							}}
							size="sm"
							variant="ghost"
						>
							It needs none
						</Button>
					) : null}
				</ContinueRow>
			</div>
		</StepItem>
	);
}
