"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { CliChatSummary } from "@/src/core";

/** "Claude CLI" entry + its saved chats. Refetches when the route changes (a new chat or a rename lands). */
export function CliSidebarSection() {
	const router = useRouter();
	const pathname = usePathname();
	const [chats, setChats] = useState<CliChatSummary[]>([]);
	useEffect(() => {
		let alive = true;
		fetch("/api/cli/chats").then((r) => r.json() as Promise<{ chats: CliChatSummary[] }>).then((j) => { if (alive) setChats(j.chats); }).catch(() => {});
		return () => { alive = false; };
	}, [pathname]);
	const create = async () => {
		const res = await fetch("/api/cli/chats", { method: "POST" });
		const j = (await res.json()) as { id: string };
		router.push(`/cli/${j.id}`);
	};
	return (
		<div className="px-3 pb-1 pt-2" data-testid="cli-sidebar">
			<button type="button" onClick={() => void create()} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
				Claude CLI
			</button>
			{chats.map((c) => (
				<button key={c.id} type="button" onClick={() => router.push(`/cli/${c.id}`)} className={`block w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent ${pathname === `/cli/${c.id}` ? "bg-accent" : ""}`}>
					{c.title}
				</button>
			))}
		</div>
	);
}
