"use client";

/**
 * The plan-limit meter (top bar). A pure view (UsageMeterView) over a
 * UsageSnapshot plus a thin fetching shell. It refreshes only when the CLI
 * reports (spec decision 9): on mount, on tab focus, and on the lh:cli-usage
 * event a CLI turn dispatches — never by polling, so it spends no quota.
 */
import { useEffect, useState } from "react";
import { isUsageStale, resetLabel, usagePercent, type UsageSnapshot, type UsageWindow } from "@/src/core";
import { pickNewerUsage, timeOfDay } from "@/components/cli-format";

function Window({ label, w, nowMs }: { label: string; w: UsageWindow | null; nowMs: number }) {
	if (!w) return null;
	const pct = usagePercent(w);
	return (
		<div className="flex items-center gap-2 text-xs" title={`${label}: ${pct}% used, ${resetLabel(w, nowMs)}`}>
			<span className="uppercase tracking-wider text-muted-foreground">{label}</span>
			<span className="h-1.5 w-14 overflow-hidden rounded-full bg-secondary" aria-hidden>
				<span className="block h-full bg-foreground" style={{ width: `${Math.min(100, pct)}%` }} />
			</span>
			<span className="tabular-nums">{pct}%</span>
			<span className="text-muted-foreground">{resetLabel(w, nowMs)}</span>
		</div>
	);
}

export function UsageMeterView({ usage, nowMs }: { usage: UsageSnapshot | null; nowMs: number }) {
	if (!usage) return <span className="text-xs text-muted-foreground" data-testid="usage-meter">Claude plan: no data yet</span>;
	return (
		<div className="flex items-center gap-4" data-testid="usage-meter">
			<Window label="5h" w={usage.fiveHour} nowMs={nowMs} />
			<Window label="7d" w={usage.sevenDay} nowMs={nowMs} />
			{isUsageStale(usage, nowMs) && <span className="text-xs text-muted-foreground">as of {timeOfDay(usage.capturedAt)}</span>}
		</div>
	);
}

export function UsageMeter() {
	const [usage, setUsage] = useState<UsageSnapshot | null>(null);
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		let alive = true;
		const load = () =>
			fetch("/api/cli/usage")
				.then((r) => r.json() as Promise<{ usage: UsageSnapshot | null }>)
				.then((j) => { if (alive) { setUsage((cur) => pickNewerUsage(cur, j.usage)); setNowMs(Date.now()); } })
				.catch(() => {});
		const onUsage = (e: Event) => { setUsage((cur) => pickNewerUsage(cur, (e as CustomEvent<UsageSnapshot>).detail)); setNowMs(Date.now()); };
		void load();
		window.addEventListener("focus", load);
		window.addEventListener("lh:cli-usage", onUsage);
		const tick = setInterval(() => setNowMs(Date.now()), 60_000); // relabel only; no network
		return () => { alive = false; window.removeEventListener("focus", load); window.removeEventListener("lh:cli-usage", onUsage); clearInterval(tick); };
	}, []);
	return <UsageMeterView usage={usage} nowMs={nowMs} />;
}
