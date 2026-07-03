// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertCircle, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface GlobalErrorDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  details?: string;
  copyText?: string;
  onClose: () => void;
}

export function GlobalErrorDialog({
  isOpen,
  title,
  message,
  details,
  copyText,
  onClose,
}: GlobalErrorDialogProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const rawErrorText = [message, details, copyText].filter(Boolean).join('\n\n');
  const isOpenRouterConfigError = /OPENROUTER_API_KEY|API key not set/i.test(rawErrorText);
  const displayTitle = isOpenRouterConfigError
    ? t('errorDialog.serviceConfigTitle')
    : title;
  const displayMessage = isOpenRouterConfigError
    ? t('errorDialog.openRouterConfigMessage')
    : message;
  const technicalDetails = useMemo(() => {
    const detailText = details?.trim();
    const messageText = message.trim();
    if (!detailText || detailText === messageText) {
      return detailText || undefined;
    }
    return detailText;
  }, [details, message]);

  // 只有真正有东西可复制（后端技术详情 / 显式 copyText）时才显示「复制报错信息」。
  // 纯提示类弹窗（如音频时长校验）没有可复制内容，隐藏该按钮避免多余。
  const canCopy = Boolean(copyText?.trim() || technicalDetails);

  useEffect(() => {
    if (isOpen) {
      setCopied(false);
      setShowDetails(false);
    }
  }, [isOpen]);

  const handleCopy = useCallback(async () => {
    const payload = copyText || [message, details].filter(Boolean).join('\n\n');
    if (!payload) {
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error('Failed to copy global error text', error);
    }
  }, [copyText, details, message]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton
        overlayClassName="bg-black/62 backdrop-blur-[2px]"
        closeButtonClassName="top-4 right-4 size-8 rounded-full bg-black/24 text-text-muted hover:bg-white/[0.08] hover:text-text-dark"
        className="gap-0 overflow-hidden rounded-md border border-white/12 bg-zinc-900/85 p-0 text-text-dark ring-0 backdrop-blur-2xl sm:max-w-[600px]"
      >
        <DialogHeader className="flex-row items-start gap-3 px-5 pb-4 pr-14 pt-5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.06] text-text-muted">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-[17px] font-semibold leading-6 text-text-dark">
              {displayTitle}
            </DialogTitle>
            <DialogDescription className="mt-2 text-[14px] leading-6 text-text-dark/78">
              {displayMessage}
            </DialogDescription>
          </div>
        </DialogHeader>

        {technicalDetails && (
          <div className="border-t border-white/[0.08] px-5 py-3">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md px-1 py-1 text-left text-[12px] font-medium text-text-muted transition-colors hover:text-text-dark"
              onClick={() => setShowDetails((value) => !value)}
            >
              <span>{t('errorDialog.technicalDetails')}</span>
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showDetails ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {showDetails && (
              <pre className="ui-scrollbar mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.12] bg-[#0b0b0b]/80 p-3 font-mono text-[12px] leading-5 text-text-dark/82">
                {technicalDetails}
              </pre>
            )}
          </div>
        )}

        <DialogFooter className="justify-end gap-2 rounded-none px-5 pb-4 pt-1">
          {canCopy && (
            <Button
              variant="ghost"
              size="sm"
              className="rounded-md px-3 text-text-dark/82 hover:bg-white/[0.07]"
              onClick={() => {
                void handleCopy();
              }}
            >
              {copied ? t('nodeToolbar.copied') : t('errorDialog.copyReport')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="rounded-md px-4"
            onClick={onClose}
          >
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
