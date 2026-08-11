import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Append-only JSONL storage partitioned into one file per UTC day.
 *
 * Day files keep retention and reads bounded: pruning is a file delete, and a
 * read only parses as many days as the caller asks for. Both the Run Record
 * archive and the Run Activity archive are built on this.
 */
export type JsonlDayFiles<Value> = Readonly<{
    /** Appends one line. Writes are serialized so lines cannot interleave. */
    append: (day: string, value: unknown) => Promise<void>;
    /** Day files inside the retention window, newest day first. */
    files: () => Promise<readonly string[]>;
    /** Reads one day file, oldest line first. Unreadable lines are skipped. */
    read: (file: string) => Promise<Value[]>;
    /** Deletes day files outside the retention window. */
    prune: () => Promise<void>;
}>;

export function createJsonlDayFiles<Value>(options: {
    directory: string;
    prefix: string;
    retentionDays: number;
    clock: () => Date;
    parse: (value: unknown) => Value | undefined;
}): JsonlDayFiles<Value> {
    const { directory, prefix, retentionDays, clock, parse } = options;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
        throw new Error("Retention days must be a positive integer");
    }
    const filePattern = new RegExp(`^${prefix}(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);

    // A single promise chain: only this process writes, and two concurrent runs
    // must not interleave partial lines in the same file.
    let pendingWrite: Promise<void> = Promise.resolve();

    const retainedDayOrEarlier = () =>
        new Date(clock().getTime() - (retentionDays - 1) * 86_400_000)
            .toISOString()
            .slice(0, 10);

    const dayFiles = async (): Promise<string[]> => {
        try {
            return (await readdir(directory))
                .filter((entry) => filePattern.test(entry))
                .sort()
                .reverse();
        } catch {
            return [];
        }
    };

    return Object.freeze({
        append: (day, value) => {
            const line = `${JSON.stringify(value)}\n`;
            const file = join(directory, `${prefix}${day}.jsonl`);
            pendingWrite = pendingWrite.then(async () => {
                await mkdir(directory, { recursive: true });
                await appendFile(file, line, "utf8");
            });
            return pendingWrite;
        },

        files: async () => {
            const cutoff = retainedDayOrEarlier();
            return (await dayFiles()).filter((file) => {
                const day = filePattern.exec(file)?.[1];
                return day !== undefined && day >= cutoff;
            });
        },

        read: async (file) => {
            let contents: string;
            try {
                contents = await readFile(join(directory, file), "utf8");
            } catch {
                return [];
            }
            const values: Value[] = [];
            for (const line of contents.split("\n")) {
                if (line.trim().length === 0) continue;
                try {
                    const parsed = parse(JSON.parse(line));
                    if (parsed !== undefined) values.push(parsed);
                } catch {
                    // Skip a truncated or hand-edited line: an operator view
                    // must still open when one entry is unreadable.
                }
            }
            return values;
        },

        prune: async () => {
            const cutoff = retainedDayOrEarlier();
            for (const file of await dayFiles()) {
                const day = filePattern.exec(file)?.[1];
                if (day !== undefined && day < cutoff) {
                    await rm(join(directory, file), { force: true });
                }
            }
        },
    });
}

/** The UTC day a timestamp belongs to, falling back to the clock. */
export function utcDayOf(timestamp: string, clock: () => Date): string {
    const day = timestamp.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day)
        ? day
        : clock().toISOString().slice(0, 10);
}
