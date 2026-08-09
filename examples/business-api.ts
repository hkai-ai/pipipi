import { createServer } from "node:http";

const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/process") {
        response.writeHead(404).end();
        return;
    }

    let body = "";
    for await (const chunk of request) body += chunk;

    try {
        const input = JSON.parse(body) as { content?: unknown };
        if (typeof input.content !== "string") {
            response.writeHead(400).end();
            return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(
            JSON.stringify({ content: `Processed: ${input.content}` }),
        );
    } catch {
        response.writeHead(400).end();
    }
});

server.listen(4000, "127.0.0.1", () => {
    console.log("Demo business API listening at http://127.0.0.1:4000");
});
