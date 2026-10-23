// SPDX-License-Identifier: Elastic-2.0
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { businessWechatQrUrl } from "@/components/login/cinematic/media";

export function EnterprisePlanPanel() {
  const { t } = useTranslation();
  const [showBusinessContact, setShowBusinessContact] = useState(false);
  return (
    <section className="grid min-h-[430px] overflow-hidden rounded-lg border border-white/10 bg-white/[0.035] lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">
      <div className="flex flex-col justify-between p-7 lg:p-10">
        <div>
          <p className="max-w-xl text-lg font-semibold leading-8">
            {t("credits.centerModal.enterprise.headline")}
          </p>
          <div className="mt-16 text-4xl font-semibold">Custom</div>
          <p className="mt-2 text-sm text-white/40">
            {t("credits.centerModal.enterprise.subtitle")}
          </p>
        </div>
        <div className="text-xs text-white/28">DramaClaw Enterprise</div>
      </div>
      <div className="border-t border-white/10 bg-black/10 p-7 lg:border-l lg:border-t-0 lg:p-10">
        <h3 className="text-sm font-semibold text-white/55">
          {t("credits.centerModal.enterprise.benefitsTitle")}
        </h3>
        <ul className="mt-6 space-y-4">
          {["quota", "priority", "templates", "security", "support"].map(
            (benefit) => (
              <li
                key={benefit}
                className="flex items-start gap-2 text-sm text-white/68"
              >
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                {t(`credits.centerModal.enterprise.benefits.${benefit}`)}
              </li>
            ),
          )}
        </ul>
        <button
          type="button"
          onClick={() => setShowBusinessContact((current) => !current)}
          className="mt-8 inline-flex h-10 w-full items-center justify-center rounded-md bg-white text-sm font-semibold text-black hover:bg-white/88"
        >
          {t("credits.centerModal.enterprise.contact")}
        </button>
        {showBusinessContact && (
          <div className="mt-4 rounded-md border border-white/10 bg-white p-3 text-center">
            <img
              src={businessWechatQrUrl}
              alt={t("auth.businessWechat.qrAlt")}
              className="mx-auto size-40 object-contain"
            />
            <p className="mt-2 text-xs text-black/60">
              {t("auth.businessWechat.note")}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
