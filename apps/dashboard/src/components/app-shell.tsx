/**
 * AppShell — the product-suite chrome: a collapsible Animate UI sidebar
 * (workspace nav + account) around the active view. Pages own their headers;
 * `topbar` slots breadcrumbs/actions next to the sidebar trigger.
 */
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LogOut, MessageSquareText, Settings2, TerminalSquare } from "lucide-react";
import { api, ApiError, type SessionUser } from "@/api";
import { cn } from "@/lib/utils";
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

const NAV = [
  { to: "/", label: "Threads", icon: MessageSquareText, end: true },
  { to: "/settings", label: "Settings", icon: Settings2, end: false },
] as const;

export function AppShell({ children, topbar }: { children: ReactNode; topbar?: ReactNode }) {
  const navigate = useNavigate();
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    api<{ user: SessionUser }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) navigate("/login");
      });
  }, [navigate]);

  const logout = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    navigate("/login");
  };

  const displayName = user?.name ?? user?.login ?? user?.email ?? "…";

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <Sidebar collapsible="icon" className="border-r border-sidebar-border">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild className="hover:bg-sidebar-accent">
                <NavLink to="/" className="gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/15">
                    <TerminalSquare className="size-4 text-primary" />
                  </span>
                  <span className="flex min-w-0 flex-col items-start leading-tight">
                    <span className="font-mono text-[13px] font-semibold tracking-tight">harness</span>
                    <span className="truncate text-[10.5px] text-muted-foreground">issue → PR agent</span>
                  </span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="font-mono text-[10.5px] tracking-widest uppercase">
              Workspace
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild tooltip={item.label}>
                      <NavLink
                        to={item.to}
                        end={item.end}
                        className={({ isActive }) =>
                          cn(
                            "gap-2.5 transition-colors",
                            isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                          )
                        }
                      >
                        <item.icon className="size-4" />
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" className="cursor-default hover:bg-transparent">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="size-8 shrink-0 rounded-lg" />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs font-semibold uppercase">
                    {displayName.slice(0, 1)}
                  </span>
                )}
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span className="truncate text-[13px] font-medium">{displayName}</span>
                  <span className="truncate text-[10.5px] text-muted-foreground">{user?.email ?? "signed in"}</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={logout} tooltip="Sign out" className="gap-2.5 text-muted-foreground">
                <LogOut className="size-4" />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="flex min-h-0 flex-col overflow-hidden bg-background">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
          <div className="h-4 w-px bg-border/70" />
          <div className="flex min-w-0 flex-1 items-center gap-2">{topbar}</div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
