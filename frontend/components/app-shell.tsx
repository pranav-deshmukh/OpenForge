"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/research", label: "Research" },
  { href: "/builder", label: "Builder" },
  { href: "/memory", label: "Memory" },
];

function AtomIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-violet-300" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <ellipse cx="12" cy="12" rx="9" ry="3.5" />
      <ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(120 12 12)" />
    </svg>
  );
}

function NavLink({ href, label, active }: NavItem & { active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-xl px-3 py-2 text-sm transition ${
        active ? "bg-violet-500/20 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
      }`}
    >
      {label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100">
      <aside className="fixed left-0 top-0 bottom-0 hidden w-60 flex-col border-r border-white/10 bg-[#111111] p-5 md:flex">
        <div className="mb-8 flex items-center gap-2 text-lg font-semibold tracking-wide">
          <AtomIcon />
          <span>PHD Agent</span>
        </div>

        <nav className="flex flex-1 flex-col gap-2">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href} label={item.label} active={pathname === item.href} />
          ))}
        </nav>

        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          Agent Online
        </div>
      </aside>

      <main className="pb-20 md:ml-60 md:pb-0">{children}</main>

      <nav className="fixed right-0 bottom-0 left-0 z-20 flex border-t border-white/10 bg-[#111111]/95 px-2 py-2 backdrop-blur md:hidden">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex-1 rounded-lg px-2 py-2 text-center text-xs ${
                active ? "bg-violet-500/25 text-white" : "text-zinc-400"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
