/**
 * FOLDER IMPORT collection (2026-10-27): turns a picked folder
 * (<input webkitdirectory>) or a dropped one (DataTransfer entries) into a
 * flat list of { file, path } where path is the file's path RELATIVE to
 * the dropped folder's parent ("Vault/Sub/Note.md"). Importable = the
 * picker's accept list (.md/.markdown/.txt); hidden files and directories
 * (".obsidian", ".git", …) are skipped without being walked.
 */
export interface PickedFile {
	file: File;
	path: string;
}

const IMPORTABLE = /\.(md|markdown|txt)$/i;

export function importableEntries(entries: readonly PickedFile[]): PickedFile[] {
	return entries.filter(({ path }) => IMPORTABLE.test(path) && !path.split("/").some((seg) => seg.startsWith(".")));
}

/** A folder chosen with <input webkitdirectory>. */
export function entriesFromFileList(list: FileList): PickedFile[] {
	return importableEntries(Array.from(list, (file) => ({ file, path: file.webkitRelativePath || file.name })));
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
	if (entry.name.startsWith(".")) return; // never descend into hidden dirs
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
		out.push({ file, path: prefix + entry.name });
		return;
	}
	if (entry.isDirectory) {
		const reader = (entry as FileSystemDirectoryEntry).createReader();
		for (;;) {
			// readEntries returns at most ~100 entries per call: loop until empty.
			const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
			if (batch.length === 0) break;
			for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
		}
	}
}

/** A drop: the entries must be read from `dt.items` SYNCHRONOUSLY (they die
 *  when the handler yields), then walked asynchronously. */
export async function entriesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
	const roots = Array.from(dt.items)
		.map((item) => item.webkitGetAsEntry?.() ?? null)
		.filter((e): e is FileSystemEntry => e !== null);
	const out: PickedFile[] = [];
	for (const root of roots) await walk(root, "", out);
	return importableEntries(out);
}
