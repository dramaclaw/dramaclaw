// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod/v4";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useAuthStore } from "@/stores/auth-store";
import { RegionSelector } from "@/components/login/region-selector";
import { clusterConfig } from "@/lib/cluster-config";
import { useRegionStore } from "@/stores/region-store";
import styles from "./login.module.css";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

type LoginForm = z.infer<typeof loginSchema>;

export function LoginCard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const [showPassword, setShowPassword] = useState(false);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const regionId = useRegionStore((s) => s.selectedRegionId);
  const needsRegion = clusterConfig.mode === "multi-region" && !regionId;

  const {
    register,
    handleSubmit,
    formState: { isSubmitting, errors },
    setError,
    clearErrors,
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  const shake = (el: HTMLInputElement | null) => {
    if (!el) return;
    el.classList.remove(styles.shake);
    void el.offsetWidth;
    el.classList.add(styles.shake);
  };

  const onInvalid = (errs: typeof errors) => {
    if (errs.username) shake(usernameRef.current);
    if (errs.password) shake(passwordRef.current);
  };

  const onSubmit = async (data: LoginForm) => {
    try {
      clearErrors();
      await login(data.username, data.password);
      const paymentRedirect = sessionStorage.getItem("supertale-payment-login-redirect");
      if (paymentRedirect === "/recharge") {
        sessionStorage.removeItem("supertale-payment-login-redirect");
        window.location.replace(paymentRedirect);
        return;
      }
      navigate({ to: "/", replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : t("auth.loginFailed");
      toast.error(message);
      setError("password", { type: "server", message });
      shake(passwordRef.current);
    }
  };

  const { ref: usernameFormRef, ...usernameRest } = register("username");
  const { ref: passwordFormRef, ...passwordRest } = register("password");

  return (
    <div className={styles.card}>
      <form
        noValidate
        className={styles.form}
        onSubmit={handleSubmit(onSubmit, onInvalid)}
      >
        <RegionSelector />
        <div className={styles.field}>
          <div className={styles.fieldRow}>
            <label htmlFor="username" className={styles.label}>
              {t("auth.username")}
            </label>
          </div>
          <div className={styles.inputWrap}>
            <input
              id="username"
              autoComplete="username"
              placeholder={t("auth.usernamePlaceholder")}
              className={`${styles.input} ${errors.username ? styles.inputInvalid : ""}`}
              {...usernameRest}
              ref={(el) => {
                usernameFormRef(el);
                usernameRef.current = el;
              }}
            />
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.fieldRow}>
            <label htmlFor="password" className={styles.label}>
              {t("auth.password")}
            </label>
          </div>
          <div className={styles.inputWrap}>
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder={t("auth.passwordPlaceholder")}
              className={`${styles.input} ${styles.inputWithEye} ${
                errors.password ? styles.inputInvalid : ""
              }`}
              {...passwordRest}
              ref={(el) => {
                passwordFormRef(el);
                passwordRef.current = el;
              }}
            />
            <button
              type="button"
              className={styles.eyeBtn}
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
              aria-label={
                showPassword ? t("auth.hidePassword") : t("auth.showPassword")
              }
            >
              {showPassword ? <EyeOff strokeWidth={2} /> : <Eye strokeWidth={2} />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          className={styles.btn}
          disabled={isSubmitting || needsRegion}
          title={needsRegion ? t("region.picker.required") : undefined}
        >
          <span>{isSubmitting ? t("auth.signingIn") : t("auth.loginButton")}</span>
          <ArrowRight className={styles.btnArrow} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
