import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { finalizeCrtImage } from "../src/business-api/crt-finalizer.js";
import { crtGrains, grainProfile } from "../src/processes/crt/style.js";

/**
 * A fixed synthetic raster stands in for a model edit. It never changes, so the
 * treatment can be compared against itself across grains and repeat runs.
 *
 * Absolute output digests are deliberately not pinned: libvips takes different
 * vectorised paths per CPU architecture, so the same input yields different
 * bytes — and different decoded pixels — on arm64 and x86_64. A pinned digest
 * therefore only holds on whichever machine produced it. What the product
 * actually promises is relative, and that is what these tests assert.
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

        // The published contract is that `normal` and an absent `grain` are
        // byte-identical, so the two outputs are compared to each other rather
        // than to a recorded digest.
        expect(omitted.bytes.equals(explicit.bytes)).toBe(true);
        expect(omitted.blockSize).toBe(4);
        expect(explicit.blockSize).toBe(4);
        expect(omitted.width).toBe(1600);
        expect(omitted.height).toBe(1200);
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
