import { access } from "node:fs/promises";

export async function chromeExecutable(): Promise<string> {
    const candidates = [
        process.env.CHROME_PATH,
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {}
    }
    throw new Error(
        "Chrome is required; set CHROME_PATH to a Chromium-compatible executable",
    );
}
