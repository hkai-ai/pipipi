# 审核后生成图片

`template-image-render/v1` 只接受已确认方案的生产项与摘要，生成一张 PNG 并返回待审图片。第二次人工确认之前不上传模板 OSS。恢复相同生产项不再次提交图片生成。

编排、来源和恢复边界见 [审核后编译模板](../template-from-source/README.md)；输入输出见 [API 文档](../../../api.md#模板图片生产与两次审核)。
