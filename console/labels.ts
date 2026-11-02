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
