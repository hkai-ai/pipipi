/** 为业务标识提供展示名称；原标识与版本始终保留用于排查。 */
const names: Record<string, string> = {
    "character-emoji": "角色表情包",
    "template-image-plan": "模板替换方案",
    "template-image-render": "模板图片生成",
    "template-from-source": "成图转模板",
    "template-from-image": "图片转模板",
    "mono-color-photo-poster": "双色油墨海报",
    "travel-abstraction-photo-poster": "旅行抽象海报",
    "dopamine-photo-poster": "多巴胺海报",
    "photo-doodle-collage": "照片涂鸦拼贴",
    "crt-interface-image": "CRT 图片",
    // 已下线的文本样板 Process，保留名称以显示历史运行记录。
    "content-processing": "文本处理",
    "titled-content-processing": "标题与正文处理",
    "minimal-zine-poster": "极简 Zine 海报",
    "manga-panels": "漫画分镜",
    "news-image-pale-watercolor": "淡彩新闻配图",
    "news-image-raw-humanism": "人文新闻配图",
    "news-image-narrative-monument": "叙事新闻配图",
    "crayon-photo-poster": "蜡笔海报",
    "monochrome-photo-poster": "黑白蜡笔海报",
    "woodcut-photo-poster": "木刻海报",
    "photo-fashion-manga": "时装漫画",
    "composed-task": "组合任务",
};
export function processName(id?: string): string {
    return id ? (names[id] ?? id) : "未知业务";
}

const activities: Record<string, string> = {
    emoji_planning: "构思表情包方案",
    character_emoji_planning: "构思表情包方案",
    character_emoji_rendering: "生成表情包图片",
    emoji_rendering: "生成表情包图片",
    content_processing: "处理文本",
    source_loading: "读取参考图片",
    replacement_planning: "规划图片替换方案",
    plan_validation: "校验替换方案",
    plan_correction: "修正替换方案",
    plan_persistence: "保存替换方案",
    approved_image_rendering: "生成已批准的图片",
    approved_image_upload: "保存已批准的图片",
    approved_image_compilation: "编译已批准图片的模板",
    template_image_loading: "读取模板参考图",
    template_compilation: "编译模板",
    template_correction: "修正模板",
    template_review: "独立复核模板",
    template_validation: "校验模板",
    photo_poster_compilation: "编译照片海报方案",
    photo_poster_rendering: "生成照片海报",
    poster_prompt_compilation: "编译海报方案",
    poster_rendering: "生成海报",
    crt_prompt_compilation: "编译 CRT 图片方案",
    crt_rendering: "生成 CRT 图片",
    news_image_prompt_compilation: "编译新闻配图方案",
    news_image_rendering: "生成新闻配图",
    process_step: "执行子流程",
};
export function activityName(id: string): string {
    return activities[id] ?? "业务处理步骤";
}
