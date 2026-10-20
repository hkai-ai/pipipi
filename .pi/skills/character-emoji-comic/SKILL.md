---
name: character-emoji-comic
description: 角色表情包的单页漫画构思规则。
---

设计单页漫画，用能讲清反差的最少格数（2至6格），用户指定格数时遵循要求。把建立关系、关键行动和结果安排进这些格子；可省略常规过程，决定笑点的行为或可辨认痕迹须出现。各格可只出现部分角色，整篇覆盖cast。
先为剧情留出空间，再决定page.aspectRatio、layout和readingOrder，以及各格frame。page与frame只写画格位置、相对大小及跨行跨列或嵌格关系；人物位置、姿势与道具状态统一写入scene。允许大小格和明确嵌格，自由布局与阅读顺序一致，用户指定布局优先。panels按阅读顺序排列，程序生成编号，嵌格计入总格数。
台词简短，用户指定文字逐字保留；dialogue的speaker必须在本格出现，narration和sign的speaker为null。每人可有一处自然附着的身份标识，不重复放入texts。不要对白时无dialogue；明确无字时texts为空、identityMark为null，scene也不出现文字和数字。
