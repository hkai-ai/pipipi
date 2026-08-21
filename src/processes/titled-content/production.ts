/** titled-content-processing/v1 的生产装配：复用 Content Processing Capability 并读取分隔符 */
import { createProductionContentProcessingCapability } from "../content/production.js";
import { defineProductionProcess } from "../production.js";
import { createTitledContentRegistration } from "./registration.js";

export const titledContentProduction = defineProductionProcess({
    id: "titled-content-processing",
    environment: [
        "BUSINESS_API_BASE_URL",
        "BUSINESS_API_TIMEOUT_MS",
        "TITLED_CONTENT_SEPARATOR",
    ],
    build: ({ environment, positiveInteger }) =>
        createTitledContentRegistration({
            capability: createProductionContentProcessingCapability(
                environment,
                positiveInteger,
            ),
            separator: environment.TITLED_CONTENT_SEPARATOR,
        }),
});
