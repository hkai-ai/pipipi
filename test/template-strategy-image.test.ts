import sharp from "sharp";
import { expect, it } from "vitest";
import { prepareStrategyImages } from "../src/processes/template-from-source/image.js";

it("总览保留原字节，局部覆盖四角和中央，不受原文件尺寸影响", async () => {
    const bytes = await sharp(
        Buffer.from(
            `<svg width="1025" height="513"><rect width="1025" height="513" fill="white"/><rect width="512" height="256" fill="red"/><rect x="513" width="512" height="256" fill="blue"/><rect y="257" width="512" height="256" fill="green"/><rect x="513" y="257" width="512" height="256" fill="black"/><rect x="480" y="230" width="70" height="55" fill="yellow"/></svg>`,
        ),
    )
        .png()
        .toBuffer();
    const image = {
        data: bytes.toString("base64"),
        mimeType: "image/png" as const,
        width: 4100,
        height: 2052,
    };
    const before = { ...image };
    const result = await prepareStrategyImages(
        image,
        new AbortController().signal,
    );
    expect(result.images).toHaveLength(6);
    expect(result.images[0].data).toBe(image.data);
    expect(image).toEqual(before);
    const colors = [
        [255, 255, 0],
        [255, 0, 0],
        [0, 0, 255],
        [0, 128, 0],
        [0, 0, 0],
    ];
    for (const [index, view] of result.images.slice(1).entries()) {
        const output = sharp(Buffer.from(view.data, "base64"));
        const meta = await output.metadata();
        expect(meta.format).toBe("png");
        expect(meta.width).toBe(1024);
        expect(meta.height).toBe(513);
        const pixel = await output
            .extract({ left: 512, top: 256, width: 1, height: 1 })
            .removeAlpha()
            .raw()
            .toBuffer();
        expect([...pixel]).toEqual(colors[index]);
    }
    expect(result.context).toContain("唯一原图");
    expect(result.context).toContain("x=512..1025");
    expect(result.context).toContain("不是新增主体");
});

it("小图不额外放大，取消后不进入模型请求", async () => {
    const bytes = await sharp({
        create: { width: 64, height: 64, channels: 3, background: "white" },
    })
        .png()
        .toBuffer();
    const image = {
        data: bytes.toString("base64"),
        mimeType: "image/png" as const,
        width: 2048,
        height: 2048,
    };
    expect(
        (await prepareStrategyImages(image, new AbortController().signal))
            .images,
    ).toHaveLength(1);
    await expect(
        prepareStrategyImages(image, AbortSignal.abort()),
    ).rejects.toThrow();
});
