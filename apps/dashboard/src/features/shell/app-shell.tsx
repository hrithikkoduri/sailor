/** Persistent visual vocabulary for every workspace view. */
import type { CSSProperties, ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  Layers2,
  LogOut,
  MessageSquare,
  Moon,
  Settings2,
  Sun,
} from "lucide-react";
import { logout } from "@/features/auth/api";
import { useUser } from "@/hooks/use-user";
import { useTheme } from "@/app/theme-provider";
import { IconButton } from "@/elements/icon-button";
import { cn } from "@/utils/cn";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/animate-ui/components/radix/sidebar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/animate-ui/components/radix/dropdown-menu";

export function AppShell({
  children,
  topbar,
}: {
  children: ReactNode;
  topbar?: ReactNode;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useUser();
  const { theme, setTheme } = useTheme();
  const name = user?.name ?? user?.login ?? user?.email ?? "Your workspace";
  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      style={{ "--sidebar-width": "232px" } as CSSProperties}
    >
      <Sidebar collapsible="icon" animateOnHover={false} className="border-r border-border">
        <SidebarHeader className="px-3 pt-4 pb-4 group-data-[collapsible=icon]:px-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                asChild
                className="h-11 hover:bg-transparent"
              >
                <NavLink to="/" aria-label="Sailor home">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Layers2 className="size-4" />
                  </span>
                  <span data-sidebar-label className="text-base font-semibold tracking-[-.04em]">
                    sailor<span className="text-muted-foreground">.</span>
                  </span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="px-3 group-data-[collapsible=icon]:px-2">
            <SidebarGroupLabel className="px-2 text-[11px] font-medium text-muted-foreground">
              Workspace
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {[
                  {
                    to: "/",
                    label: "Threads",
                    icon: MessageSquare,
                    active:
                      pathname === "/" || pathname.startsWith("/threads/"),
                  },
                  {
                    to: "/settings",
                    label: "Settings",
                    icon: Settings2,
                    active: pathname.startsWith("/settings"),
                  },
                ].map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={item.active}
                      tooltip={item.label}
                      className="h-10 rounded-lg px-2.5 text-[13px] data-[active=true]:bg-card data-[active=true]:shadow-xs"
                    >
                      <NavLink
                        to={item.to}
                        aria-label={item.label}
                        aria-current={item.active ? "page" : undefined}
                        className="gap-3"
                      >
                        <item.icon className="size-4 text-muted-foreground" />
                        <span data-sidebar-label>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <div data-sidebar-label className="mt-auto px-5 pb-6 group-data-[collapsible=icon]:hidden">
            <p className="text-xs font-medium">A little less busywork.</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              From an issue to a reviewed fix.
              <br />
              With every step accounted for.
            </p>
          </div>
        </SidebarContent>
        <SidebarFooter className="border-t border-border p-3 group-data-[collapsible=icon]:p-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="gap-2.5 rounded-lg"
                aria-label="Account menu"
              >
                {user?.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt=""
                    className="size-8 rounded-full"
                  />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-medium">
                    {name.slice(0, 1)}
                  </span>
                )}
                <span data-sidebar-label className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs font-medium">
                    {name}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    Personal workspace
                  </span>
                </span>
                <ChevronDown data-sidebar-label className="size-3 text-muted-foreground" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              className="w-56 rounded-xl p-1.5"
            >
              <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                {user?.email ?? name}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("/settings")}>
                <Settings2 />
                Workspace settings
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setTheme(theme === "light" ? "dark" : "light")}
              >
                {theme === "light" ? <Moon /> : <Sun />}Switch to{" "}
                {theme === "light" ? "dark" : "light"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  void logout().then(() => navigate("/login"));
                }}
              >
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-hidden bg-background">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 md:px-6">
          <SidebarTrigger className="size-8 text-muted-foreground" />
          <div className="h-4 w-px bg-border" />
          <div className="flex min-w-0 flex-1 items-center gap-2">{topbar}</div>
          <IconButton
            label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="shrink-0 text-muted-foreground"
          >
            {theme === "light" ? <Moon /> : <Sun />}
          </IconButton>
        </header>
        <div className={cn("flex min-h-0 flex-1 flex-col")}>{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
