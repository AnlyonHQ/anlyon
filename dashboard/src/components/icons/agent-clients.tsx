import type { ReactElement, ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Glyph({
	children,
	filled,
	...props
}: IconProps & { children: ReactNode; filled?: boolean }) {
	return (
		<svg
			width={16}
			height={16}
			viewBox="0 0 24 24"
			aria-hidden="true"
			fill={filled ? "currentColor" : "none"}
			stroke={filled ? undefined : "currentColor"}
			strokeWidth={filled ? undefined : 1.8}
			strokeLinecap={filled ? undefined : "round"}
			strokeLinejoin={filled ? undefined : "round"}
			{...props}
		>
			{children}
		</svg>
	);
}

export function ClaudeIcon(props: IconProps) {
	return (
		<Glyph filled {...props}>
			<path d="M12 2.5c.9 4 1.7 5.9 3.3 7.5s3.5 2.4 7.5 3.3c-4 .9-5.9 1.7-7.5 3.3S12.9 20 12 24c-.9-4-1.7-5.9-3.3-7.5S5.2 14.1 1.2 13.2c4-.9 5.9-1.7 7.5-3.3S11.1 6.5 12 2.5Z" />
		</Glyph>
	);
}

export function CursorIcon(props: IconProps) {
	return (
		<Glyph filled {...props}>
			<path d="M5 3.2 19.4 11l-6.6 1.5-2 6.3L5 3.2Z" />
		</Glyph>
	);
}

export function WindsurfIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M13 3.5v12.5L4 16 13 3.5Z" fill="currentColor" stroke="none" />
			<path d="M3 19.5c1.8 0 1.8 1.5 3.6 1.5s1.8-1.5 3.6-1.5 1.8 1.5 3.6 1.5 1.8-1.5 3.6-1.5 1.8 1.5 3.6 1.5" />
		</Glyph>
	);
}

export function CopilotIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M6 9.5C7 6 9.4 4.4 12 4.4S17 6 18 9.5" />
			<path d="M3.5 12.2c0-1.5 1-2.6 2.6-2.6s2.6 1.1 2.6 2.6v2.4c0 1.5-1 2.6-2.6 2.6s-2.6-1.1-2.6-2.6v-2.4Z" />
			<path d="M14.7 12.2c0-1.5 1-2.6 2.6-2.6s2.6 1.1 2.6 2.6v2.4c0 1.5-1 2.6-2.6 2.6s-2.6-1.1-2.6-2.6v-2.4Z" />
			<path d="M8.7 13c1.1-1 5.5-1 6.6 0" />
		</Glyph>
	);
}

export function CodexIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M12 2.7 20.3 7.4v9.2L12 21.3 3.7 16.6V7.4L12 2.7Z" />
			<path d="M12 8 16.3 10.5v5L12 18l-4.3-2.5v-5L12 8Z" />
		</Glyph>
	);
}

export interface AgentClient {
	name: string;
	Icon: (props: IconProps) => ReactElement;
}

export const AGENT_CLIENTS: AgentClient[] = [
	{ name: "Claude Code", Icon: ClaudeIcon },
	{ name: "Cursor", Icon: CursorIcon },
	{ name: "Windsurf", Icon: WindsurfIcon },
	{ name: "GitHub Copilot", Icon: CopilotIcon },
	{ name: "Codex", Icon: CodexIcon },
];
