/** 从 Memebuy 同步生成的纯拆解检查器；通过 build-template-v4-contract.ts 更新。 */
// 拆解数据编译器的输入输出类型。字段与 Skill compile.py 的中文键一一对应，见各字段注释。
import type { DesignSpecBorderId } from "./design-spec-schema.js";

/** 改画法、换边框、换场景：结构化修改里与画法相关的三项，只做数据与编译支持（P4 接翻译层）。 */
export interface DesignSpecEditOverrides {
    /** 画法覆盖文字：画法段改用它，参考图降为只取内容与版面 */
    techniqueOverride?: string;
    /** 换边框库 id：仅对容器为边框库或背景为承重的模板生效 */
    borderOverride?: DesignSpecBorderId;
    /** 承重背景的场景描述：仅对承重背景生效 */
    sceneOverride?: string;
}

/** 迁移条目：一次编译用的“用户输入”快照（中文键：迁移）；由默认值或输入映射产出，不入库。 */
export interface MigrationEntry extends DesignSpecEditOverrides {
    id: string;
    /** 主体（主体）：身份与外形的完整短语 */
    subject: string;
    /** 主体名（主体名） */
    subjectName: string;
    subjectShape?: string;
    subjectInherentColor?: string;
    pose?: string;
    fun?: string;
    /** 主体已被用户的文字或照片换掉（中文键：主体已替换）；与未被用户填写的“跟随主体”文字共同决定那些文字改由模型来写 */
    subjectReplaced?: boolean;
    /** 文字元素 id → 逐字文本；主体已替换时，未被用户填写的“跟随主体”文字不在其中 */
    texts: Record<string, string>;
    /** 点缀、装饰元素 id → 用户指定内容 */
    specifiedContent: Record<string, string>;
    /** 场景伴生点缀元素 id → 来源 */
    accentSources: Record<string, string>;
    /** 配色角色 id → 具体颜色 */
    colors: Record<string, string>;
}

/** 本次生成实际附上的参考图。 */
export interface AttachmentFacts {
    /** 附模板原图（compile.py 的 --ref orig） */
    templateImage: boolean;
    /** 附用户主体照片（compile.py 的 --ref subject） */
    subjectPhoto: boolean;
}

export interface DesignSpecCheckResult {
    /** 阻断：v4 数据不合格，导入时拒绝 */
    errors: string[];
    /** 提示：需要人复核，不阻断 */
    warnings: string[];
}

export interface CompiledDesignSpecPrompt {
    prompt: string;
    /** 编译阶段的外形泄漏警告，已按码点排序去重 */
    warnings: string[];
}

/** 执行计划消费的编译产物：与 Compact / Seven 的编译结果同形，plan 与 Provider 不需要认识 v4。 */
export interface DesignSpecPlanCompilation {
    providerPrompt: string;
    /** v4 的附图说明写在提示词开头，不另出角色绑定段 */
    imageRoleContext: string;
    claims: {
        identity: Array<{
            sourceId: string;
            inputId: string;
            targetIds: string[];
        }>;
        content: Array<{
            sourceId: string;
            inputId: string;
            targetIds: string[];
        }>;
        reference: Array<{
            sourceId: string;
            inputId: string;
            targetIds: string[];
        }>;
    };
    /** 空数组 = 没有可改写片段：用户逐字文本与拆解数据都不允许提示词修复改写 */
    repairSegments: [];
    trace: { promptFormat: "design_spec_v1" };
}
