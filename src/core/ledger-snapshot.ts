/** Verbatim capture/restore of the five rewritable graph ledgers (undo). */
import type { LedgerSnapshot } from "./contracts/cli.ts";
import type { GraphStore } from "./ports.ts";

export function snapshotLedgers(store: GraphStore): LedgerSnapshot {
	return structuredClone({
		nodes: store.readNodes(),
		chains: store.readChains(),
		coverage: store.readCoverage(),
		checkpoints: store.readCheckpoints(),
		positions: store.readPositions(),
	});
}

export function restoreLedgers(store: GraphStore, snap: LedgerSnapshot): void {
	store.rewriteLedgers({ nodes: snap.nodes, chains: snap.chains, coverage: snap.coverage, checkpoints: snap.checkpoints });
	store.writePositions(snap.positions);
}
