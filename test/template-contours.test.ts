import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { measureContentContours } from "../src/processes/template-from-image/contours.js";
import { prepareTemplateImageViews } from "../src/processes/template-from-image/image-views.js";

async function blocks(
    tops: number[],
    foreground = "blue",
    background = "white",
) {
    return sharp(
        Buffer.from(
            `<svg width="480" height="240"><rect width="480" height="240" fill="${background}"/>${tops.map((top, i) => `<rect x="${40 + i * 56}" y="${top}" width="40" height="40" fill="${foreground}"/>`).join("")}</svg>`,
        ),
    )
        .png()
        .toBuffer();
}
const signal = () => new AbortController().signal;

describe("内容轮廓的像素依据", () => {
    it.each([
        ["平直", [80, 80, 80, 80, 80, 80, 80]],
        ["中部较高", [90, 82, 74, 70, 74, 82, 90]],
        ["局部交错", [70, 90, 70, 90, 70, 90, 70]],
    ] as const)(
        "%s的上下边缘来自像素，不统一成某种曲线",
        async (_name, tops) => {
            const bytes = await blocks([...tops]);
            const result = await measureContentContours(bytes, signal());
            expect(result).not.toBeNull();
            expect(result?.bands).toHaveLength(1);
            if (!result) throw new Error("应测得内容带");
            const band = result.bands[0];
            expect(band.bounds).toEqual({
                left: 40,
                right: 415,
                top: Math.min(...tops),
                bottom: Math.max(...tops) + 39,
            });
            for (const sample of band.samples) {
                const intersecting = tops.filter(
                    (_top, i) =>
                        40 + i * 56 <= sample.x1 && 79 + i * 56 >= sample.x0,
                );
                expect(sample.top).toBe(
                    intersecting.length ? Math.min(...intersecting) : null,
                );
                expect(sample.bottom).toBe(
                    intersecting.length ? Math.max(...intersecting) + 39 : null,
                );
            }
            expect(result).not.toHaveProperty("shape");
            expect(band.horizontalSections).toHaveLength(3);
            if (_name === "平直") {
                expect(
                    band.horizontalSections.map((section) => [
                        section.meanTop,
                        section.meanBottom,
                    ]),
                ).toEqual([
                    [80, 119],
                    [80, 119],
                    [80, 119],
                ]);
            } else if (_name === "中部较高") {
                const [left, middle, right] = band.horizontalSections;
                if (middle.meanTop === null || middle.meanBottom === null)
                    throw new Error("中间区域应有可测前景");
                expect(left.meanTop).toBeGreaterThan(middle.meanTop);
                expect(right.meanBottom).toBeGreaterThan(middle.meanBottom);
            }
        },
    );

    it("不依赖红字白底，并且按解码图片尺寸报告坐标", async () => {
        const bytes = await blocks(
            [80, 80, 80, 80, 80, 80, 80],
            "white",
            "black",
        );
        const image = {
            data: bytes.toString("base64"),
            mimeType: "image/png" as const,
            width: 960,
            height: 480,
        };
        const views = await prepareTemplateImageViews(
            image,
            signal(),
            "content",
        );
        expect(views.images[0].data).toBe(image.data);
        expect(views.contours).toMatchObject({ width: 480, height: 240 });
        expect(views.context).toContain("不是字体基线");
        const regions = await prepareTemplateImageViews(
            image,
            signal(),
            "regions",
        );
        expect(regions.context).not.toContain("辅助像素测量");
    });

    it("背景不均匀或无内容时不制造轮廓依据", async () => {
        const background = await sharp(
            Buffer.from(
                '<svg width="480" height="240"><rect width="240" height="240" fill="black"/><rect x="240" width="240" height="240" fill="white"/></svg>',
            ),
        )
            .png()
            .toBuffer();
        expect(await measureContentContours(background, signal())).toBeNull();
        const blank = await blocks([]);
        expect(await measureContentContours(blank, signal())).toBeNull();
    });

    it("取消时不继续解码测量", async () => {
        const controller = new AbortController();
        controller.abort(new Error("已取消"));
        await expect(
            measureContentContours(Buffer.alloc(0), controller.signal),
        ).rejects.toThrow("已取消");
    });
});
