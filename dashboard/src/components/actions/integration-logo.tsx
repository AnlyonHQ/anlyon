import { integrationPresentation } from "@/lib/integration-catalog";
import { cn } from "@/lib/utils";

export function IntegrationLogo({
	id,
	name,
	className,
}: {
	id: string;
	name: string;
	className?: string;
}) {
	const { logo } = integrationPresentation(id);
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-10 shrink-0 items-center justify-center border bg-white",
				className,
			)}
		>
			{logo ? (
				<img alt="" className="size-1/2 object-contain" src={logo} />
			) : (
				<span className="font-heading text-lg text-neutral-900 uppercase">
					{name.slice(0, 1)}
				</span>
			)}
		</span>
	);
}
