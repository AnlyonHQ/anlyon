import { cn } from "@/lib/utils";

export function AppLogo({
	size = 32,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<>
			<img
				src="/logo-light-v2.png"
				alt="Anlyon"
				height={size}
				className={cn("w-auto object-contain dark:hidden", className)}
				style={{ height: size }}
			/>
			<img
				src="/logo-dark-v2.png"
				alt="Anlyon"
				height={size}
				className={cn("hidden w-auto object-contain dark:block", className)}
				style={{ height: size }}
			/>
		</>
	);
}
