/** Persistent visual vocabulary for every workspace view. */
import type { CSSProperties, ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { panelTransition } from "@/utils/motion";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown,
  Bug,
  LogOut,
  MessageSquare,
  Moon,
  Settings2,
  Sun,
  House,
  CircleDot,
  GitPullRequest,
  Activity,
  Plus,
} from "lucide-react";
import { logout } from "@/features/auth/api";
import { useUser } from "@/hooks/use-user";
import { useTheme } from "@/app/theme-provider";
import { Logo } from "@/elements/brand";
import { IconButton } from "@/elements/icon-button";
import { Button } from "@/elements/button";
import { useDebugMode } from "@/features/debug/debug-provider";
import { cn } from "@/utils/cn";
import { ThreadDock } from "@/features/thread-tabs/thread-dock";
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
  customThreadHeader = false,
}: {
  children: ReactNode;
  topbar?: ReactNode;
  customThreadHeader?: boolean;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user } = useUser();
  const { theme, setTheme } = useTheme();
  const { enabled: debug, toggle: toggleDebug } = useDebugMode();
  const name = user?.name ?? user?.login ?? user?.email ?? "Your workspace";
  const reduce = useReducedMotion();
  return (
    <SidebarProvider
      className="h-svh min-h-0 overflow-hidden"
      style={{ "--sidebar-width": "232px" } as CSSProperties}
    >
      <Sidebar
        collapsible="icon"
        animateOnHover={false}
        className="border-r border-border"
      >
        <SidebarHeader className="px-3 pt-4 pb-4 group-data-[collapsible=icon]:px-2">
          <div className="flex items-center gap-2">
            <SidebarMenu className="min-w-0 flex-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  asChild
                  className="h-11 hover:bg-transparent"
                >
                  <NavLink to="/" aria-label="Sailor home">
                    <Logo size={32} />
                    <span
                      data-sidebar-label
                      className="text-base font-semibold tracking-[-.04em]"
                    >
                      sailor<span className="text-muted-foreground">.</span>
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarTrigger className="shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="px-3 group-data-[collapsible=icon]:px-2">
            <SidebarGroupLabel className="px-2 text-[11px] font-medium text-muted-foreground">
              Workspace
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {[
                  { to: "/", label: "Home", icon: House, active: pathname === "/" },
                  {
                    to: "/threads",
                    label: "Threads",
                    icon: MessageSquare,
                    active:
                      pathname === "/threads" || pathname.startsWith("/threads/"),
                  },
                  { to: "/issues", label: "Issues", icon: CircleDot, active: pathname === "/issues" },
                  { to: "/pull-requests", label: "Pull requests", icon: GitPullRequest, active: pathname === "/pull-requests" },
                  { to: "/traces", label: "Traces", icon: Activity, active: pathname === "/traces" },
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
          <SidebarGroup className="px-3 group-data-[collapsible=icon]:px-2">
            <SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild tooltip="New thread" className="h-10 rounded-lg border border-input bg-card shadow-xs">
              <NavLink to="/threads/new"><Plus className="size-4" /><span data-sidebar-label>New thread</span></NavLink>
            </SidebarMenuButton></SidebarMenuItem></SidebarMenu>
          </SidebarGroup>
          <div
            data-sidebar-label
            className="mt-auto px-5 pb-6 group-data-[collapsible=icon]:hidden"
          >
            <p className="text-xs font-medium">A little less busywork.</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              From an idea to shipped work.
              <br />
              With every step accounted for.
            </p>
          </div>
        </SidebarContent>
        <SidebarFooter className="border-t border-border p-3 group-data-[collapsible=icon]:p-2">
          {/* Expanding from the collapsed icon state needs a visible,
              keyboard-reachable control; the edge rail alone is mouse-only. */}
          <SidebarMenu className="mb-2 group-data-[collapsible=icon]:mb-1">
            <SidebarMenuItem>
              <SidebarTrigger
                title="Expand sidebar"
                className="mx-auto hidden size-8 text-muted-foreground group-data-[collapsible=icon]:flex"
              />
            </SidebarMenuItem>
          </SidebarMenu>
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
                <ChevronDown
                  data-sidebar-label
                  className="size-3 text-muted-foreground"
                />
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
                onSelect={toggleDebug}
                aria-keyshortcuts="Meta+Shift+D Control+Shift+D"
              >
                <Bug aria-hidden />
                {debug ? "Disable debug mode" : "Enable debug mode"}
              </DropdownMenuItem>
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
          {/* Desktop collapses from the sidebar rail; this is the mobile-only
              way to open the off-canvas sidebar. */}
          <SidebarTrigger className="size-8 text-muted-foreground sm:hidden" />
          {topbar !== undefined && (
            <div className={cn("flex min-w-0 items-center gap-2", customThreadHeader ? "flex-1" : "shrink-0")}>{topbar}</div>
          )}
          {!customThreadHeader && <ThreadDock />}
          {debug && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
              onClick={toggleDebug}
              aria-label="Disable debug mode"
              aria-pressed="true"
              aria-keyshortcuts="Meta+Shift+D Control+Shift+D"
              title="Debug mode · ⌘⇧D / Ctrl+Shift+D · click to disable"
            >
              <Bug aria-hidden className="size-3" />
              Debug
            </Button>
          )}
          <IconButton
            label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="shrink-0 text-muted-foreground"
          >
            {theme === "light" ? <Moon /> : <Sun />}
          </IconButton>
        </header>
        <motion.div key={pathname} data-workspace-content className="relative flex min-h-0 flex-1 flex-col"
          initial={{ y: reduce ? 0 : 6 }} animate={{ y: 0 }} transition={reduce ? { duration: 0 } : panelTransition}>
          {children}
        </motion.div>
      </SidebarInset>
    </SidebarProvider>
  );
}
