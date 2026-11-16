/** 母版分档、色键与对照校验的具名阈值，每个常量写明来源或理由。 */

/** 单档生成尝试数：首次 + 最多 2 次带原因重试（合同已拍板）。 */
export const GENERATED_TIER_TRIES = 3;

/** 输出边长上限：与 preparedImage 的 4096 合同一致；超出的原图在轻档等比缩小。 */
export const MAX_SIDE = 4096;
/** 输出边长下限：低于此值印不出可用图案；Memebuy 不以 150dpi 分档，此处只拦明显过小的图。 */
export const MIN_SIDE = 256;

/** 色键：与边缘主色的 RGB 欧氏距离不超过此值视为底色。干净平面稿的底色漂移在 10 以内，取 28 留出抗锯齿与轻微压缩余量。 */
export const COLOR_KEY_TOLERANCE = 28;
/** 色键：边缘像素中接近主色的比例低于此值，说明底不是单一衬底（照片、渐变），不做色键。 */
export const COLOR_KEY_EDGE_UNIFORM_MIN = 0.85;
/** 色键：贴着已去除区域的一圈边缘像素用更宽的容差再去一次，清掉底色与墨色混合的抗锯齿带；只做一轮，不扩散。 */
export const COLOR_KEY_FRINGE_TOLERANCE = 64;

/** 印花验收的分析边长（缩到 640 像素计），沿用 Memebuy 印花验收脚本的口径。 */
export const ANALYSIS_SIDE = 640;
/** 不透明像素：alpha 达到此值算“实心”，对应 Memebuy 说明里生成图实心多为 250～253。 */
export const ALPHA_SOLID = 250;
/** 可见像素：alpha 达到此值算前景存在。 */
export const ALPHA_VISIBLE = 128;
/** 半透明下限：alpha 低于此值视为全透明残值（Memebuy：全透明带 1～6，含余量）。 */
export const ALPHA_FLOOR = 16;
/** 截断：画布外圈宽度占短边比例（Memebuy：外圈 1%）。 */
export const TRUNCATION_RING_RATIO = 0.01;
/** 截断：外圈不透明像素占比超过此值判截断（Memebuy：2%）。 */
export const TRUNCATION_MAX_RING_SHARE = 0.02;
/** 整张矩形：独立图形整张不透明占比超过此值判整张印成矩形（Memebuy：90%）。 */
export const STANDALONE_MAX_OPAQUE_SHARE = 0.9;
/** 光晕：半透明像素离最近实心区超过此像素数（640 尺度）才算光晕，干净抗锯齿边约 1～2（Memebuy）。 */
export const HALO_MIN_DISTANCE_PX = 4;
/** 光晕：远离实心区的半透明像素占前景比例上限（Memebuy：5%）。 */
export const HALO_MAX_FOREGROUND_SHARE = 0.05;
/** 不透明形态（rect_patch / bleed_crop）允许的非实心像素占比，容纳压缩与缩放产生的个别像素。 */
export const OPAQUE_FORM_MAX_TRANSPARENT_SHARE = 0.001;

/** 色板：CIE76 色差上限。约 2.3 为可察觉差异，生成模型的颜色漂移常见在 10～15，取 20。 */
export const PALETTE_MAX_DELTA_E = 20;
/** 色板：每个默认颜色在前景中至少要有的像素占比；细线条文字占比小，取 0.1%。 */
export const PALETTE_MIN_COVERAGE = 0.001;
/** 色板：取色时的采样边长，最近邻缩放保持纯色不被混合。 */
export const PALETTE_SAMPLE_SIDE = 256;

/** 相似度：两图缩到此边长的灰度图比较。 */
export const SIMILARITY_SIDE = 32;
/** 轻档相似度下限：只去底，内容应与原图几乎一致。 */
export const SIMILARITY_MIN_LIGHT = 0.95;
/** 中档相似度下限：模型重绘会带来细节与比例偏移，只要求整体明暗布局仍是原图。尚未用真实样本标定。 */
export const SIMILARITY_MIN_MEDIUM = 0.6;

/** 模型校验的单图观察上限：与既有看图 Agent 的网关请求预算一致。 */
export const VERIFIER_VIEW_BYTES = 112 * 1024;
/** 模型校验一次调用的最长等待。 */
export const VERIFIER_TIMEOUT_MS = 90_000;
/** 改图调用的最长等待，略高于 Business API 的 180 秒。 */
export const EDIT_TIMEOUT_MS = 200_000;
/** 上传调用的最长等待。 */
export const UPLOAD_TIMEOUT_MS = 60_000;
/** 参考图附给改图模型前的最长边，控制请求体；仍是完整原图，不裁切。 */
export const EDIT_REFERENCE_MAX_SIDE = 2048;
