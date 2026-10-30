/** 声明模板编译内部使用的 Gallery v2 数据形状，实际边界由固定 Schema 校验。 */
export type TemplateSlot = {
    id: string;
    label: string;
    required: boolean;
    text: { defaultValue: string; suggestions: string[] };
    image?: {
        promptValue: string;
        minWidth: number;
        minHeight: number;
        private: boolean;
        sourceOptions: string[];
    };
};

export type Template = {
    key: string;
    status: "DRAFT";
    title: string;
    description: string;
    kind: "PROMPT";
    cover: string;
    referenceImage: string;
    imageSize: string;
    imageN: 1;
    preprocessSteps: [];
    promptTemplate: string;
    inputSchema: { version: 2; slots: TemplateSlot[] };
    runtimeSemantics: {
        version: 2;
        targetInstances: {
            id: string;
            kind: "identity_subject" | "identity_group" | "content_element";
            role: string;
            region: string;
            minMembers?: number;
            maxMembers?: number;
        }[];
        inputBindings: Record<
            string,
            {
                operation: "replace_identity" | "replace_content";
                targetIds: string[];
                bindingPolicy?:
                    | "one_to_one"
                    | "same_source_repeated"
                    | "preserve_group";
                clothingOwnership?: "source" | "template";
            }
        >;
        visualContract: {
            medium: string;
            styleTraits: string[];
            composition: string[];
            relations: string[];
            colorAndLight: string[];
        };
    };
    metadata: { tags: string[] };
};

export type TemplateDraft = Pick<
    Template,
    | "key"
    | "title"
    | "description"
    | "promptTemplate"
    | "inputSchema"
    | "runtimeSemantics"
    | "metadata"
>;
