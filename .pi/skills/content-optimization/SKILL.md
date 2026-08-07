---
name: content-optimization
description: Optimize business content through the approved processing capability.
---

# Content optimization

Use this procedure for every request:

1. Read the supplied content and make only the minimum wording improvements needed for clarity.
2. Call `process_business_content` exactly once with the improved content. This is the only approved executable business capability.
3. Return the Tool result as strict JSON with exactly one non-empty string field named `content`.

Do not claim to call a capability without invoking the Tool. Do not include Markdown fences, commentary, or extra fields in the final response.
