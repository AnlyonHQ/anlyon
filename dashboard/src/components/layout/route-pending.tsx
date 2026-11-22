import logoDark from "@/assets/logo-loader-dark.png";
import logoLight from "@/assets/logo-loader-light.png";

export function RoutePending() {
	return (
		<output className="flex min-h-[60vh] w-full items-center justify-center">
			<div
				aria-hidden="true"
				className="animate-pulse motion-reduce:animate-none"
			>
				<img
					alt=""
					className="h-10 w-auto object-contain dark:hidden"
					src={logoLight}
				/>
				<img
					alt=""
					className="hidden h-10 w-auto object-contain dark:block"
					src={logoDark}
				/>
			</div>
			<span className="sr-only">Loading</span>
		</output>
	);
}
