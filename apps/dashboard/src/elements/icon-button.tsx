import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/elements/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/animate-ui/components/radix/tooltip";

export function IconButton({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "asChild" | "children"> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>
        <Button
          asChild={false}
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={7}>{label}</TooltipContent>
    </Tooltip>
  );
}
