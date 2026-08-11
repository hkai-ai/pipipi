import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { finalizeCrtImage } from "../src/business-api/crt-finalizer.js";
import { crtGrains, grainProfile } from "../src/processes/crt/style.js";

/**
 * A fixed synthetic raster stands in for a model edit. It never changes, so the
 * digests below pin the exact treatment callers receive.
 */
async function fixtureRaster(): Promise<Buffer> {
    const width = 640;
    const height = 480;
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
        pixels[index * 3] = (index * 7) % 256;
        pixels[index * 3 + 1] = (index * 13) % 256;
        pixels[index * 3 + 2] = (index * 29) % 256;
    }
    return sharp(pixels, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer();
}

function digest(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

const normalDigest =
    "561b79c7c1e08b628da43f673f5d48fd336c244b876129291168148a457f267a";

describe("CRT finalizer grains", () => {
    it("reproduces the pre-grain treatment when no grain is requested", async () => {
        const generated = await fixtureRaster();

        const omitted = await finalizeCrtImage({
            generated,
            palette: "经典",
            aspectRatio: "4:3",
        });
        const explicit = await finalizeCrtImage({
            generated,
            palette: "经典",
            aspectRatio: "4:3",
            grain: "normal",
        });

        expect(digest(omitted.bytes)).toBe(normalDigest);
        expect(digest(explicit.bytes)).toBe(normalDigest);
        expect(omitted.blockSize).toBe(4);
    });

    it("produces a distinct, deterministic treatment per grain", async () => {
        const generated = await fixtureRaster();
        const digests = new Set<string>();

        for (const grain of crtGrains) {
            const first = await finalizeCrtImage({
                generated,
                palette: "经典",
                aspectRatio: "4:3",
                grain,
            });
            const second = await finalizeCrtImage({
                generated,
                palette: "经典",
                aspectRatio: "4:3",
                grain,
            });

            expect(first.bytes.equals(second.bytes)).toBe(true);
            expect(first.blockSize).toBe(grainProfile(grain).blockSize);
            expect(first.width).toBe(1600);
            expect(first.height).toBe(1200);
            digests.add(digest(first.bytes));
        }

        expect(digests.size).toBe(crtGrains.length);
    });

    it("keeps every grain inside the requested palette", async () => {
        const generated = await fixtureRaster();

        for (const grain of crtGrains) {
            const finalized = await finalizeCrtImage({
                generated,
                palette: "经典",
                aspectRatio: "4:3",
                grain,
            });
            const { data, info } = await sharp(finalized.bytes)
                .removeAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
            const used = new Set<string>();
            for (
                let offset = 0;
                offset < data.length;
                offset += info.channels
            ) {
                used.add(
                    `${data[offset]},${data[offset + 1]},${data[offset + 2]}`,
                );
            }

            expect(used.size).toBeLessThanOrEqual(finalized.colors.length);
        }
    });
});
