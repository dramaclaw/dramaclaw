// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { approveBlenderPairing } from "@/features/blender/api";
import { BlenderClientList } from "@/features/blender/BlenderClientList";
import { BLENDER_PAGE_CARD } from "@/features/blender/styles";

/**
 * 读查询串里的配对码。
 *
 * 用 `new URLSearchParams` 而不是路由的 `validateSearch`：仓库里后者一次都没用过。
 *
 * 注意这个码**可能拿不到**——`_app` 的 beforeLoad 未登录就跳 /login，而那个跳转不带
 * 任何回跳信息，登录后固定落在 /，码就丢了。所以输入框必须是可编辑的，用户能照着
 * Blender 面板上显示的码手敲。
 */
function codeFromQuery(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("code") ?? "";
}

/** 从 ky 的错误里抠出后端那句 detail。抠不出来就返回空串，让调用方用兜底文案。 */
async function backendDetail(error: unknown): Promise<string> {
  const response = (error as { response?: { json?: () => Promise<unknown> } })?.response;
  if (!response?.json) return "";
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : "";
  } catch {
    return "";
  }
}

export function BlenderPairingPage() {
  const { t } = useTranslation();
  const [code, setCode] = useState(codeFromQuery);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [clientsKey, setClientsKey] = useState(0);
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  // 从 Blender 点「连接」打开的是一个全新标签页，没有站内历史：这时 history.back()
  // 要么没反应、要么直接退出站点，所以退回首页。
  function goBack() {
    if (canGoBack) router.history.back();
    else void navigate({ to: "/" });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || !code.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await approveBlenderPairing(code.trim());
      setDone(true);
      // 码不留在地址栏，免得跟着浏览器历史、书签、截图到处跑。
      window.history.replaceState({}, "", window.location.pathname);
      setClientsKey((value) => value + 1);
    } catch (caught) {
      // 后端故意不区分「码不对 / 过期 / 用过了」，原话转给用户就好，别自己编。
      setError((await backendDetail(caught)) || t("common.error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-10">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2.5 w-fit rounded-full text-muted-foreground"
        onClick={goBack}
      >
        <ArrowLeft />
        {t("common.back")}
      </Button>
      <Card className={BLENDER_PAGE_CARD}>
        <CardHeader>
          <CardTitle>
            <h1>{t("blender.pairing.title")}</h1>
          </CardTitle>
          <CardDescription>{t("blender.pairing.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="flex flex-col items-start gap-3">
              <p className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
                {t("blender.pairing.success")}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setDone(false);
                  setCode("");
                }}
              >
                {t("blender.pairing.again")}
              </Button>
            </div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <div className="flex flex-col gap-2">
                <Label htmlFor="blender-pairing-code">{t("blender.pairing.codeLabel")}</Label>
                <Input
                  id="blender-pairing-code"
                  value={code}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("blender.pairing.codePlaceholder")}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "blender-pairing-error" : undefined}
                  // 大字号等宽：这个码是从 Blender 面板上一位一位比对过来的。
                  className="h-10 rounded-[var(--ui-radius-lg)] border-[var(--ui-border-soft)] bg-[var(--ui-surface-field)] font-mono text-lg tracking-widest dark:bg-[var(--ui-surface-field)]"
                  onChange={(event) => setCode(event.target.value)}
                />
                {error ? (
                  <p id="blender-pairing-error" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
              {/* 这一屏唯一的高饱和元素：DESIGN.md 的 button-primary（青底、36px 高）。 */}
              <Button
                type="submit"
                className="h-9 rounded-md bg-primary font-semibold text-primary-foreground hover:bg-primary/90"
                disabled={submitting || !code.trim()}
              >
                {submitting ? t("blender.pairing.submitting") : t("blender.pairing.submit")}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <BlenderClientList key={clientsKey} />
    </div>
  );
}
