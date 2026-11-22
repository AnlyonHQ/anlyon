"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "@/lib/utils";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverPopup({
	children,
	className,
	side = "bottom",
	align = "center",
	sideOffset = 4,
	alignOffset = 0,
	tooltipStyle = false,
	...props
}: PopoverPrimitive.Popup.Props & {
	side?: PopoverPrimitive.Positioner.Props["side"];
	align?: PopoverPrimitive.Positioner.Props["align"];
	sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
	alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
	tooltipStyle?: boolean;
}) {
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				className="z-50 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
				data-slot="popover-positioner"
				side={side}
				sideOffset={sideOffset}
			>
				<PopoverPrimitive.Popup
					className={cn(
						"relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-xl border bg-popover text-popover-foreground shadow-lg transition-[width,height,scale,opacity] duration-150 ease-out data-starting-style:scale-98 data-starting-style:opacity-0",
						tooltipStyle && "w-fit text-balance text-xs",
						className,
					)}
					data-slot="popover-popup"
					{...props}
				>
					<PopoverPrimitive.Viewport
						className={cn(
							"relative size-full max-h-(--available-height) overflow-clip px-4 py-3 outline-none data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2rem-2px)] **:data-previous:w-[calc(var(--popup-width)-2rem-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
							tooltipStyle
								? "px-2 py-1"
								: "not-data-transitioning:overflow-y-auto",
						)}
						data-slot="popover-viewport"
					>
						{children}
					</PopoverPrimitive.Viewport>
				</PopoverPrimitive.Popup>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
	return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
	return (
		<PopoverPrimitive.Title
			className={cn("font-semibold text-sm leading-snug", className)}
			data-slot="popover-title"
			{...props}
		/>
	);
}

function PopoverDescription({
	className,
	...props
}: PopoverPrimitive.Description.Props) {
	return (
		<PopoverPrimitive.Description
			className={cn("text-[13px] text-muted-foreground", className)}
			data-slot="popover-description"
			{...props}
		/>
	);
}

export {
	PopoverCreateHandle,
	Popover,
	PopoverTrigger,
	PopoverPopup,
	PopoverPopup as PopoverContent,
	PopoverTitle,
	PopoverDescription,
	PopoverClose,
};
