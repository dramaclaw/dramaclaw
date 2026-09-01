// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AlertTriangle, CheckCircle2, CircleX } from "lucide-react";
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
 *
 * 中英各一套：解析器两种格式都认（utils/screenplay_scene_parser.py），但样例是
 * 「照着抄」的模板，中文界面给中文制片格式、英文界面给 Fountain 格式，混着给等于没给。
 */
// i18n-exempt-start —— 样例本身就是解析器认的制片格式，翻译过去就不是那个格式了
const DRAMA_FORMAT_SPEC = [
  "中文制片格式（任选一种）",
  "1-1 苏鸾寝殿 深夜 内",
  "1.1 苏鸾寝殿 内 深夜",
  "",
  "中文分字段格式",
  "场次：1",
  "地点：苏鸾寝殿",
  "时间：深夜",
  "内外景：内",
  "",
  "Fountain / Final Draft 格式",
  "内景 苏鸾寝殿 - 深夜",
  "INT. BEDROOM - NIGHT",
].join("\n");

const DRAMA_REPAIRABLE_FORMAT = [
  "第1集",
  "",
  "1.1 苏鸾寝殿 内",
  "人物：苏糖、锦绣",
  "▲ 漆黑寝殿，烛火摇曳。",
  "苏糖：锦绣，几更了？",
].join("\n");

const DRAMA_FORMAT_EXAMPLE = [
  "第1集",
  "1-1 苏鸾寝殿 深夜 内",
  "人物：苏糖、锦绣",
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

const DRAMA_FORMAT_SPEC_EN = [
  "Fountain / Final Draft (recommended)",
  "INT. SEOUL SUBWAY STATION - NIGHT",
  "EXT. SEOUL STREET - DAWN",
  "INT./EXT. MOVING TAXI - DAY",
  "",
  "Time values",
  "DAY / NIGHT / MORNING / AFTERNOON / EVENING / DAWN / DUSK",
  "",
  "Exact clock time (its own line, under the heading)",
  "INT. SEOUL SUBWAY STATION - NIGHT",
  "Time: 11:47 PM",
].join("\n");

const DRAMA_REPAIRABLE_FORMAT_EN = [
  "EPISODE 1",
  "",
  "SCENE 1 - SEOUL SUBWAY STATION",
  "Characters: Ji-won, Old Woman",
  "△ Rainwater drips from the ceiling.",
  "JI-WON: Is anyone here?",
].join("\n");

const DRAMA_FORMAT_EXAMPLE_EN = [
  "EPISODE 1",
  "",
  "INT. SEOUL SUBWAY STATION - NIGHT",
  "Characters: Ji-won, Old Woman",
  "",
  "△ Rainwater drips from the ceiling. The platform is completely empty.",
  "",
  "JI-WON: Is anyone here?",
  "",
  "OLD WOMAN: You should not have come this late.",
  "",
  "",
  "INT. SUBWAY CAR - NIGHT",
  "Characters: Ji-won, Old Woman, Boy",
  "",
  "△ The train doors close. The lights flicker above the empty seats.",
  "",
  "JI-WON: Where is this train going?",
  "",
  "OLD WOMAN: To the last station.",
  "",
  "",
  "EXT. SEOUL STREET - DAWN",
  "Characters: Ji-won",
  "",
  "△ Ji-won steps onto the deserted street as the first morning light appears.",
  "",
  "JI-WON: I made it back.",
].join("\n");
// i18n-exempt-end

/** 样例按界面语言取，不按剧本语言：这是「照着抄」的模板，跟着读的人走。 */
const FORMAT_SAMPLES = {
  zh: {
    spec: DRAMA_FORMAT_SPEC,
    repairable: DRAMA_REPAIRABLE_FORMAT,
    example: DRAMA_FORMAT_EXAMPLE,
  },
  en: {
    spec: DRAMA_FORMAT_SPEC_EN,
    repairable: DRAMA_REPAIRABLE_FORMAT_EN,
    example: DRAMA_FORMAT_EXAMPLE_EN,
  },
} as const;

export function NovelFormatDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const samples = (i18n.resolvedLanguage ?? i18n.language ?? "").startsWith("zh")
    ? FORMAT_SAMPLES.zh
    : FORMAT_SAMPLES.en;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl rounded-lg bg-black sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("ingest.novelFormat.title")}</DialogTitle>
        </DialogHeader>

        {/* 滚动条做细做淡：长度由内容/视口比例决定，改不动，只能让它别抢戏。 */}
        <ScrollArea className="max-h-[58vh] [&_[data-slot=scroll-area-scrollbar]]:w-1.5 [&_[data-slot=scroll-area-thumb]]:bg-white/15">
          <div className="space-y-5 pr-3">
            <p className="text-sm leading-6 text-foreground/75">
              {t("ingest.novelFormat.intro")}
            </p>

            <section className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  {t("ingest.novelFormat.standardStatus")}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {t("ingest.novelFormat.standardStatusHint")}
                </p>
              </div>
              <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.06] p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                  <AlertTriangle className="size-3.5" />
                  {t("ingest.novelFormat.warningStatus")}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {t("ingest.novelFormat.warningStatusHint")}
                </p>
              </div>
              <div className="rounded-md border border-destructive/25 bg-destructive/[0.07] p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <CircleX className="size-3.5" />
                  {t("ingest.novelFormat.blockingStatus")}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {t("ingest.novelFormat.blockingStatusHint")}
                </p>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.specLabel")}
              </h3>
              <pre className="whitespace-pre-wrap rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[13px] leading-7 text-foreground/90">
                {samples.spec}
              </pre>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.repairableLabel")}
              </h3>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("ingest.novelFormat.repairableHint")}
              </p>
              <pre className="whitespace-pre-wrap rounded-md border border-amber-500/15 bg-amber-500/[0.04] px-3.5 py-3 text-[13px] leading-7 text-foreground/80">
                {samples.repairable}
              </pre>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.rulesLabel")}
              </h3>
              <ul className="list-disc space-y-1.5 pl-5 text-xs leading-5 text-foreground/70">
                <li>{t("ingest.novelFormat.ruleEpisode")}</li>
                <li>{t("ingest.novelFormat.ruleScene")}</li>
                <li>{t("ingest.novelFormat.ruleCharacters")}</li>
                <li>{t("ingest.novelFormat.ruleBody")}</li>
                <li>{t("ingest.novelFormat.ruleDialogue")}</li>
                <li>{t("ingest.novelFormat.ruleLocationChange")}</li>
                <li>{t("ingest.novelFormat.ruleTimeTokens")}</li>
                <li>{t("ingest.novelFormat.ruleClockTime")}</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.exampleLabel")}
              </h3>
              <pre className="whitespace-pre-wrap rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[13px] leading-7 text-foreground/70">
                {samples.example}
              </pre>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
