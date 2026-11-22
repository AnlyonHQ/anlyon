import * as React from "react";
import { useTheme } from "@/contexts/theme-provider";

const COLORS = {
	light: "#008a5d",
	dark: "#E8F5E9",
};

function isSystemDark() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function")
		return false;
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function useResolvedTheme(theme: "dark" | "light" | "system") {
	const [resolved, setResolved] = React.useState<"dark" | "light">(() => {
		if (theme === "system") {
			return isSystemDark() ? "dark" : "light";
		}
		return theme;
	});
	React.useEffect(() => {
		if (theme !== "system") {
			setResolved(theme);
			return;
		}
		const listener = () => {
			setResolved(isSystemDark() ? "dark" : "light");
		};
		const mql = window.matchMedia("(prefers-color-scheme: dark)");
		mql.addEventListener("change", listener);
		setResolved(isSystemDark() ? "dark" : "light");
		return () => {
			mql.removeEventListener("change", listener);
		};
	}, [theme]);
	return resolved;
}

export const LogoVariant3 = ({
	size = 64,
	color,
}: {
	size?: number;
	color?: string;
}) => {
	const { theme } = useTheme();
	const currentTheme = useResolvedTheme(theme);

	const mainColor =
		color ?? (currentTheme === "dark" ? COLORS.dark : COLORS.light);

	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 64 64"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className="group/logo relative"
			style={{ display: "block" }}
		>
			<style>
				{`
          .logo-bar1, .logo-bar2, .logo-bar3, .logo-dash {
            transition: fill 0.45s cubic-bezier(.6,.05,.21,1), stroke 0.45s cubic-bezier(.6,.05,.21,1), opacity 0.4s;
          }
          .logo-bar1 {
            transform-origin: 32px 24px;
            transition-property: fill, transform, opacity;
            transition-duration: 0.45s, 0.45s, 0.4s;
            transition-delay: 0s, 0.05s, 0.1s;
          }
          .logo-bar2 {
            transform-origin: 36px 40px;
            transition-property: fill, transform, opacity;
            transition-duration: 0.45s, 0.45s, 0.4s;
            transition-delay: 0s, 0.12s, 0.05s;
          }
          .logo-bar3 {
            transform-origin: 40px 56px;
            transition-property: fill, transform, opacity;
            transition-duration: 0.45s, 0.45s, 0.4s;
            transition-delay: 0s, 0.18s, 0.2s;
          }
          .logo-dash {
            transition-property: stroke, transform;
            transition-duration: 0.35s, 0.4s;
            transition-delay: 0.15s, 0s;
          }
          .group\\/logo:hover .logo-bar1 {
            transform: scaleY(1.07) translateY(-2px) skewY(-1deg);
            filter: brightness(105%);
          }
          .group\\/logo:hover .logo-bar2 {
            transform: scaleY(1.05) translateY(-1px) skewY(.7deg);
            filter: brightness(110%);
          }
          .group\\/logo:hover .logo-bar3 {
            transform: scaleY(0.97) translateY(2px) skewY(1deg);
            filter: brightness(120%);
          }
          .group\\/logo:hover .logo-dash {
            transform: scaleY(1.1) skewY(2deg);
            filter: brightness(120%);
          }
        `}
			</style>
			<path
				className="logo-bar1"
				d="M12 20H52C53.1046 20 54 20.8954 54 22V26C54 27.1046 53.1046 28 52 28H12C10.8954 28 10 27.1046 10 26V22C10 20.8954 10.8954 20 12 20Z"
				fill={mainColor}
				opacity={1}
			/>
			<path
				className="logo-bar2"
				d="M16 36H56C57.1046 36 58 36.8954 58 38V42C58 43.1046 57.1046 44 56 44H16C14.8954 44 14 43.1046 14 42V38C14 36.8954 14.8954 36 16 36Z"
				fill={mainColor}
				opacity={0.6}
			/>
			<path
				className="logo-bar3"
				d="M20 52H60C61.1046 52 62 52.8954 62 54V58C62 59.1046 61.1046 60 60 60H20C18.8954 60 18 59.1046 18 58V54C18 52.8954 18.8954 52 20 52Z"
				fill={mainColor}
				opacity={0.3}
			/>
			<path
				className="logo-dash"
				d="M32 28V36M32 44V52"
				stroke={mainColor}
				strokeWidth="1.5"
				strokeDasharray="2,2"
			/>
		</svg>
	);
};
