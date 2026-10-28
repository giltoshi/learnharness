"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { CliChatSummary } from "@/src/core";

/** "Claude CLI" entry + its saved chats. Refetches when the route changes (a new chat or a rename lands). */
export function CliSidebarSection() {
	const router = useRouter();
	const pathname = usePathname();
	const [chats, setChats] = useState<CliChatSummary[]>([]);
	useEffect(() => {
		let alive = true;
		fetch("/api/cli/chats")
			.then(async (r) => (r.ok ? ((await r.json()) as { chats?: unknown }) : null))
			.then((j) => { if (alive && j && Array.isArray(j.chats)) setChats(j.chats as CliChatSummary[]); })
			.catch(() => {});
		return () => { alive = false; };
	}, [pathname]);
	const creating = useRef(false);
	const create = async () => {
		if (creating.current) return;
		creating.current = true;
		try {
			const res = await fetch("/api/cli/chats", { method: "POST" });
			if (!res.ok) throw new Error(`Create failed (${res.status})`);
			const j = (await res.json()) as { id?: string };
			if (typeof j.id !== "string") throw new Error("Create returned no id");
			router.push(`/cli/${j.id}`);
		} catch (err) {
			console.error(err);
		} finally {
			creating.current = false;
		}
	};
	return (
		<div className="px-3 pb-1 pt-2" data-testid="cli-sidebar">
			<button type="button" onClick={() => void create()} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
				Claude CLI
			</button>
			{chats.map((c) => (
				<button key={c.id} type="button" aria-current={pathname === `/cli/${c.id}` ? "page" : undefined} onClick={() => router.push(`/cli/${c.id}`)} className={`block w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-accent ${pathname === `/cli/${c.id}` ? "bg-accent" : ""}`}>
					{c.title}
				</button>
			))}
		</div>
	);
}
