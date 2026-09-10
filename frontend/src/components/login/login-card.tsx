// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
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
import { phoneOtpEntryVisible } from "@/lib/runtime-config";
import { useRegionStore } from "@/stores/region-store";
import {
  AuthApiError,
  newAuthIdempotencyKey,
  requestOtp,
  type OtpChallenge,
} from "@/lib/auth-api";
import styles from "./login.module.css";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

type LoginForm = z.infer<typeof loginSchema>;
type LoginMode = "otp" | "password";

export function LoginCard() {
  const { t } = useTranslation();
  const regionId = useRegionStore((s) => s.selectedRegionId);
  const needsRegion = clusterConfig.mode === "multi-region" && !regionId;
  const otpEntryVisible = phoneOtpEntryVisible();
  const [mode, setMode] = useState<LoginMode>(() =>
    otpEntryVisible ? "otp" : "password",
  );

  if (!otpEntryVisible) {
    return (
      <div className={styles.card}>
        <RegionSelector />
        <PasswordLoginForm needsRegion={needsRegion} phoneIdentityVisible={false} />
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <RegionSelector />
      <div className={styles.loginModes} role="tablist" aria-label={t("auth.loginMethod")}>
        <button
          type="button"
          role="tab"
          id="otp-login-tab"
          aria-controls="otp-login-panel"
          aria-selected={mode === "otp"}
          className={styles.loginMode}
          data-active={mode === "otp"}
          onClick={() => setMode("otp")}
        >
          {t("auth.otp.tab")}
        </button>
        <button
          type="button"
          role="tab"
          id="password-login-tab"
          aria-controls="password-login-panel"
          aria-selected={mode === "password"}
          className={styles.loginMode}
          data-active={mode === "password"}
          onClick={() => setMode("password")}
        >
          {t("auth.passwordTab")}
        </button>
      </div>

      {mode === "otp" ? (
        <div id="otp-login-panel" role="tabpanel" aria-labelledby="otp-login-tab">
          <OtpLoginForm key={regionId ?? "no-region"} needsRegion={needsRegion} />
        </div>
      ) : (
        <div id="password-login-panel" role="tabpanel" aria-labelledby="password-login-tab">
          <PasswordLoginForm needsRegion={needsRegion} phoneIdentityVisible />
        </div>
      )}
    </div>
  );
}

function PasswordLoginForm({
  needsRegion,
  phoneIdentityVisible,
}: {
  needsRegion: boolean;
  phoneIdentityVisible: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const [showPassword, setShowPassword] = useState(false);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
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

  const shake = (element: HTMLInputElement | null) => {
    if (!element) return;
    element.classList.remove(styles.shake);
    void element.offsetWidth;
    element.classList.add(styles.shake);
  };

  const onSubmit = async (data: LoginForm) => {
    try {
      clearErrors();
      await login(data.username, data.password);
      void navigate({ to: "/", replace: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("auth.loginFailed");
      toast.error(message);
      setError("password", { type: "server", message });
      shake(passwordRef.current);
    }
  };

  const { ref: usernameFormRef, ...usernameRest } = register("username");
  const { ref: passwordFormRef, ...passwordRest } = register("password");

  return (
    <form
      noValidate
      className={styles.form}
      onSubmit={handleSubmit(onSubmit, (errors) => {
        if (errors.username) shake(usernameRef.current);
        if (errors.password) shake(passwordRef.current);
      })}
    >
      <div className={styles.field}>
        <div className={styles.fieldRow}>
          <label htmlFor="username" className={styles.label}>
            {t(phoneIdentityVisible ? "auth.accountOrPhone" : "auth.account")}
          </label>
        </div>
        <div className={styles.inputWrap}>
          <input
            id="username"
            autoComplete="username"
            placeholder={t(
              phoneIdentityVisible
                ? "auth.accountOrPhonePlaceholder"
                : "auth.accountPlaceholder",
            )}
            className={`${styles.input} ${errors.username ? styles.inputInvalid : ""}`}
            {...usernameRest}
            ref={(element) => {
              usernameFormRef(element);
              usernameRef.current = element;
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
            ref={(element) => {
              passwordFormRef(element);
              passwordRef.current = element;
            }}
          />
          <button
            type="button"
            className={styles.eyeBtn}
            onClick={() => setShowPassword((visible) => !visible)}
            tabIndex={-1}
            aria-label={showPassword ? t("auth.hidePassword") : t("auth.showPassword")}
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
  );
}

function OtpLoginForm({ needsRegion }: { needsRegion: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const loginWithOtp = useAuthStore((state) => state.loginWithOtp);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const requestKeyRef = useRef<string | null>(null);
  const verifyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown(countdown - 1), 1_000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const requestCode = async () => {
    if (!phone.trim() || requesting || countdown > 0 || needsRegion) return;
    setRequesting(true);
    setError(null);
    requestKeyRef.current ??= newAuthIdempotencyKey();
    try {
      const nextChallenge = await requestOtp(phone.trim(), requestKeyRef.current);
      setChallenge(nextChallenge);
      setCountdown(60);
      setCode("");
      requestKeyRef.current = null;
      verifyKeyRef.current = newAuthIdempotencyKey();
      toast.success(t("auth.otp.sent", { phone: nextChallenge.phone_masked }));
    } catch (requestError) {
      const message = otpErrorMessage(requestError, "request", t);
      setError(message);
      toast.error(message);
    } finally {
      setRequesting(false);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!challenge || !/^[0-9]{6}$/.test(code) || verifying || needsRegion) return;
    setVerifying(true);
    setError(null);
    verifyKeyRef.current ??= newAuthIdempotencyKey();
    try {
      const result = await loginWithOtp(
        phone.trim(),
        challenge.verification_id,
        code,
        verifyKeyRef.current,
      );
      if (result.created_user) {
        toast.success(t("auth.otp.accountCreated"));
      } else if (!result.password_configured) {
        toast.success(t("auth.otp.passwordNotSet"));
      }
      void navigate({ to: "/", replace: true });
    } catch (verifyError) {
      const message = otpErrorMessage(verifyError, "verify", t);
      if (
        verifyError instanceof AuthApiError &&
        (verifyError.code === "OTP_CHALLENGE_EXHAUSTED" ||
          verifyError.code === "OTP_CHALLENGE_CONSUMED")
      ) {
        setChallenge(null);
        setCode("");
        setCountdown(0);
        requestKeyRef.current = null;
        verifyKeyRef.current = null;
      }
      setError(message);
      toast.error(message);
    } finally {
      setVerifying(false);
    }
  };

  const resetPhone = () => {
    setChallenge(null);
    setCode("");
    setCountdown(0);
    setError(null);
    requestKeyRef.current = null;
    verifyKeyRef.current = null;
  };

  return (
    <form noValidate className={styles.form} onSubmit={submit}>
      <div className={styles.field}>
        <div className={styles.fieldRow}>
          <label htmlFor="otp-phone" className={styles.label}>
            {t("auth.otp.phone")}
          </label>
          {challenge ? (
            <button type="button" className={styles.fieldAction} onClick={resetPhone}>
              {t("auth.otp.changePhone")}
            </button>
          ) : null}
        </div>
        <div className={styles.inputWrap}>
          <input
            id="otp-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            disabled={Boolean(challenge)}
            placeholder={t("auth.otp.phonePlaceholder")}
            className={styles.input}
            onChange={(event) => setPhone(event.currentTarget.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <div className={styles.fieldRow}>
          <label htmlFor="otp-code" className={styles.label}>
            {t("auth.otp.code")}
          </label>
        </div>
        <div className={styles.inputWrap}>
          <input
            id="otp-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            disabled={!challenge}
            placeholder={t("auth.otp.codePlaceholder")}
            className={`${styles.input} ${styles.codeInput}`}
            onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
          />
          <button
            type="button"
            className={styles.sendCodeButton}
            disabled={!phone.trim() || requesting || countdown > 0 || needsRegion}
            onClick={() => void requestCode()}
          >
            {requesting
              ? t("auth.otp.sending")
              : countdown > 0
                ? t("auth.otp.resendIn", { seconds: countdown })
                : challenge
                  ? t("auth.otp.resend")
                  : t("auth.otp.send")}
          </button>
        </div>
      </div>

      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.otpHint}>{t("auth.otp.autoRegisterHint")}</p>
      )}

      <button
        type="submit"
        className={styles.btn}
        disabled={!challenge || code.length !== 6 || verifying || needsRegion}
        title={needsRegion ? t("region.picker.required") : undefined}
      >
        <span>{verifying ? t("auth.otp.verifying") : t("auth.otp.loginButton")}</span>
        <ArrowRight className={styles.btnArrow} strokeWidth={2.4} aria-hidden="true" />
      </button>
    </form>
  );
}

function otpErrorMessage(
  error: unknown,
  operation: "request" | "verify",
  t: (key: string) => string,
): string {
  if (error instanceof AuthApiError) {
    if (error.status === 400) return t("auth.otp.invalidPhone");
    if (error.status === 401) return t("auth.otp.invalidCode");
    if (
      error.code === "OTP_CHALLENGE_EXHAUSTED" ||
      error.code === "OTP_CHALLENGE_CONSUMED"
    ) {
      return t("auth.otp.invalidCode");
    }
    if (error.status === 429) return t("auth.otp.rateLimited");
    if (error.status === 503) return t("auth.otp.unavailable");
  }
  return t(operation === "request" ? "auth.otp.requestFailed" : "auth.otp.verifyFailed");
}
