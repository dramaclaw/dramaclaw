// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * 精品剧（drama）的导入标准格式与示例。逐行写死而不是塞进 i18n 的长字符串：
 * 这是要按原样展示的样例，任何换行/空格都有意义，不该被译者改动。
 */
const DRAMA_FORMAT_SPEC = [
  "第X集",
  "1-X 场景：【内/外 地点 日/夜】",
  "人物：",
  "△ 画面描述：[动作清晰，无多余修饰，直白描述]",
  "角色A(表情/动作)：台词内容",
  "△ 画面描述：",
  "角色B(表情/动作)：台词内容",
  "△ 画面描述：",
  "角色A OS：内心独白内容",
].join("\n");

const DRAMA_FORMAT_EXAMPLE = [
  "第 1 集",
  "1-1 场景：苏鸾寝殿深夜内",
  "人物：苏糖（附身苏鸾）、锦绣（贴身侍女）",
  "△【闪回】漆黑寝殿，匕首尖正对跳动的烛火，刀身映出一张布满冷汗、瞳孔骤缩的少女脸。",
  "△苏糖 OS：我不能死！",
  "△【闪出】寒光匕首狠狠刺入少女心口，鲜血瞬间喷溅在锦被上。凶手缓缓抬头，露出贴身侍女锦绣冰冷的脸。",
  "△苏糖 OS：我不能死得不明不白！",
  "△【闪回】现代大学宿舍，书本被狠狠砸在地上，苏糖和室友激烈争吵。",
  "△苏糖 OS：我叫苏糖，普通女大学生。昨天还在跟人吵架，今天一睁眼……",
  "△【闪出】苏糖猛地从床榻弹坐而起，寝衣被冷汗浸透，双手死死攥住床帐，指节泛白。",
  "苏糖（大口喘气，眼神涣散，声音发颤）：这种风格是……《乱世凤鸣录》？",
  "△【特写】一双纤白细腻、完全陌生的手，在苏糖眼前缓缓攥成拳。",
  "△苏糖 OS：这里是凤鸣大陆，七国乱战。我附身的人，是苏鸾！",
  "△苏糖浑身剧烈一颤。",
  "△苏糖 OS：这个世界的规则只有一条——弱肉强食。原著里，苏鸾是个路人甲。",
  "△寝殿门扇“吱呀”一声，悄无声息推开一道缝。",
  "△【特写】一只素白的手端着青瓷汤碗走入，宽大袖口滑落，手腕处一道细长的刀鞘轮廓，一闪而过。",
  "△苏糖 OS：她会死。三天后，在这张床上，被她最信任的侍女一刀穿心。",
  "△锦绣垂着头，无声走到床边，面色平静得没有一丝波澜。",
  "苏糖（瞬间收敛所有情绪，声音带着刚睡醒的沙哑慵懒）：锦绣，几更了？",
  "锦绣（头埋得极低，声音恭顺）：回公主，三更。公主噩梦惊醒，奴婢炖了安神汤。",
  "△苏糖的眼神骤然锐利，随即立刻垂下眼帘，露出一副困倦不堪的模样。",
].join("\n");

export function NovelFormatDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl rounded-lg bg-black sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("ingest.novelFormat.title")}</DialogTitle>
        </DialogHeader>

        {/* 滚动条做细做淡：长度由内容/视口比例决定，改不动，只能让它别抢戏。 */}
        <ScrollArea className="max-h-[58vh] [&_[data-slot=scroll-area-scrollbar]]:w-1.5 [&_[data-slot=scroll-area-thumb]]:bg-white/15">
          <div className="space-y-5 pr-3">
            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.specLabel")}
              </h3>
              <pre className="whitespace-pre-wrap rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[13px] leading-7 text-foreground/90">
                {DRAMA_FORMAT_SPEC}
              </pre>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.exampleLabel")}
              </h3>
              <pre className="whitespace-pre-wrap rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[13px] leading-7 text-foreground/70">
                {DRAMA_FORMAT_EXAMPLE}
              </pre>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
