import { afterEach, expect, it, vi } from "vitest";
import { createTemplateImageRenderer } from "../src/business-api/template-image-fal.js";
import { HttpTemplateImagePreparation } from "../src/processes/template-from-source/capability.http.js";

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
it.each([400, 401, 403, 422, 408, 409, 425, 429, 500, 503])(
    "HTTP %s 只提交一次且不泄漏正文",
    async (status) => {
        const transport = vi.fn(
            async () => new Response("PRIVATE-BODY", { status }),
        );
        vi.stubGlobal("fetch", transport);
        const renderer = createTemplateImageRenderer("PRIVATE-KEY");
        const error = await renderer
            .submit(
                "https://example.com/input.png",
                "PRIVATE-PROMPT",
                "1024x1024",
                signal(),
            )
            .catch((error) => error);
        expect(error).toMatchObject({
            type:
                status < 500 && ![408, 409, 425, 429].includes(status)
                    ? "provider_rejected"
                    : "submission_unknown",
            httpStatus: status,
        });
        expect(JSON.stringify(error)).not.toContain("PRIVATE");
        expect(transport).toHaveBeenCalledTimes(1);
        const [url, init] = transport.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe("https://queue.fal.run/openai/gpt-image-2/edit");
        expect(init).toMatchObject({ method: "POST", redirect: "error" });
        expect(JSON.parse(String(init.body))).toMatchObject({
            quality: "low",
            num_images: 1,
            output_format: "png",
            image_size: { width: 1024, height: 1024 },
        });
    },
);
it("断连和无效回执均保持未知，成功只返回请求标识", async () => {
    const transport = vi
        .fn()
        .mockRejectedValueOnce(new Error("PRIVATE-URL"))
        .mockResolvedValueOnce(Response.json({ request_id: "../../bad" }))
        .mockResolvedValueOnce(Response.json({ request_id: "request-1" }));
    vi.stubGlobal("fetch", transport);
    const renderer = createTemplateImageRenderer("test");
    for (let i = 0; i < 2; i++)
        await expect(
            renderer.submit(
                "https://example.com/image",
                "prompt",
                "1024x1024",
                signal(),
            ),
        ).rejects.toMatchObject({ type: "submission_unknown" });
    expect(
        await renderer.submit(
            "https://example.com/image",
            "prompt",
            "1024x1024",
            signal(),
        ),
    ).toBe("request-1");
    expect(transport).toHaveBeenCalledTimes(3);
});
it.each(["host-init", "host-upload", "status", "result", "submit"])(
    "取消 %s 会终止底层 HTTP，不触发新生成",
    async (stage) => {
        const controller = new AbortController();
        let reached!: () => void;
        const pending = new Promise<void>((resolve) => {
            reached = resolve;
        });
        const transport = vi.fn(
            async (url: string | URL | Request, init?: RequestInit) => {
                if (stage === "host-upload" && String(url).includes("initiate"))
                    return Response.json({
                        upload_url: "https://upload.example.com/file",
                        file_url: "https://image.example.com/file",
                    });
                if (stage === "result" && String(url).includes("/status"))
                    return Response.json({ status: "COMPLETED" });
                return new Promise<Response>((_resolve, reject) => {
                    expect(init?.signal).toBe(controller.signal);
                    init?.signal?.addEventListener(
                        "abort",
                        () => reject(new Error("cancelled")),
                        { once: true },
                    );
                    reached();
                });
            },
        );
        vi.stubGlobal("fetch", transport);
        const renderer = createTemplateImageRenderer("test");
        const work = stage.startsWith("host")
            ? renderer.host(
                  Buffer.from("image"),
                  "image/png",
                  controller.signal,
              )
            : stage === "submit"
              ? renderer.submit(
                    "https://example.com/image",
                    "prompt",
                    "1024x1024",
                    controller.signal,
                )
              : renderer.result("request-1", controller.signal);
        const assertion = expect(work).rejects.toThrow();
        await pending;
        controller.abort();
        await assertion;
        expect(
            transport.mock.calls.filter(([url]) =>
                String(url).endsWith("/edit"),
            ),
        ).toHaveLength(stage === "submit" ? 1 : 0);
    },
);
it("取消轮询间隔时立即结束，不再查询", async () => {
    const controller = new AbortController();
    const transport = vi.fn(async () =>
        Response.json({ status: "IN_PROGRESS" }),
    );
    vi.stubGlobal("fetch", transport);
    const work = createTemplateImageRenderer("test").result(
        "request-1",
        controller.signal,
    );
    const assertion = expect(work).rejects.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assertion;
    expect(transport).toHaveBeenCalledTimes(1);
});

it("原图托管最多三次，失败不会提交生成", async () => {
    const transport = vi.fn(
        async () => new Response("private", { status: 503 }),
    );
    vi.stubGlobal("fetch", transport);
    await expect(
        createTemplateImageRenderer("test").host(
            Buffer.from("image"),
            "image/png",
            signal(),
        ),
    ).rejects.toThrow("源图托管失败");
    expect(transport).toHaveBeenCalledTimes(3);
    expect(
        transport.mock.calls.every((call) =>
            String((call as unknown as [unknown])[0]).includes(
                "storage/upload/initiate",
            ),
        ),
    ).toBe(true);
}, 25000);

it.each([
    "provider_rejected",
    "submission_unknown",
    "reapproval_required",
    "PRIVATE-REASON",
])("内部 HTTP 仅透传白名单分类 %s", async (reason) => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json(
                { error: { reason, message: "PRIVATE-BODY" } },
                { status: 503 },
            ),
        ),
    );
    const capability = new HttpTemplateImagePreparation(
        "http://127.0.0.1:4400",
    );
    const error = await capability
        .render(
            {
                productionId: "51a07b2d-a62b-4fc1-83eb-969a2447e937",
                objectSha256: "a".repeat(64),
                reviewerRef: "operator",
            },
            signal(),
        )
        .catch((error) => error);
    expect(error).toMatchObject({
        reason: reason === "PRIVATE-REASON" ? "incomplete" : reason,
    });
    expect(error.message).not.toContain("PRIVATE");
});
