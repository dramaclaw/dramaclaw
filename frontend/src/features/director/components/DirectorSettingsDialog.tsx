// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from './DirectorReferenceIcon';
import { readDirectorPreference, saveDirectorPreference } from '../director-ui-state';

export function DirectorSettingsDialog({ onClose, onMethods }: {
  onClose: () => void; onMethods: () => void;
}) {
  const { t } = useTranslation();
  const [notifications, setNotifications] = useState<boolean>(() => typeof Notification !== 'undefined' && Notification.permission === 'granted' && readDirectorPreference<boolean>('notifications', false));
  const [sound, setSound] = useState(() => readDirectorPreference('sound', true));
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => previous?.focus();
  }, []);
  const requestNotification = async () => {
    if (notifications) { setNotifications(false); return; }
    if (typeof Notification === 'undefined') { setError(t('director.surface.notificationDenied')); return; }
    try {
      const permission = await Notification.requestPermission();
      setNotifications(permission === 'granted');
      if (permission !== 'granted') setError(t('director.surface.notificationDenied'));
    } catch { setError(t('director.surface.notificationDenied')); }
  };
  const toggle = (label: string, checked: boolean, onClick?: () => void, disabled = false) => <button type="button" className="dc-toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={onClick}><span /></button>;
  return <div className="dc-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="dc-settings-dialog" role="dialog" aria-modal="true" aria-label={t('director.settings')} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),select,input')];
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus(); }
        else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0]?.focus(); }
      }
    }}>
      <header><h2>TV Director {t('director.settings')}</h2><button type="button" aria-label={t('director.close')} onClick={onClose}><X size={18} /></button></header>
      <section><h3>{t('director.surface.collaboration')}</h3>
        <div className="dc-setting-row"><div><p>{t('director.surface.autoGenerate')}</p><small>{t('director.manualApprovalOnly')}</small><small>{t('director.surface.newSessionDefault')}</small></div>{toggle(t('director.surface.autoGenerate'), false, undefined, true)}</div>
        <div className="dc-setting-row"><div><p>{t('director.surface.budget')}</p><small>{t('director.surface.noPrice')}</small></div>{toggle(t('director.surface.budget'), false, undefined, true)}</div>
        <div className="dc-setting-row dc-threshold"><span>{t('director.surface.threshold')}</span><button type="button" disabled title={t('director.surface.noPrice')}>—</button></div>
      </section>
      <section><h3>{t('director.surface.notifications')}</h3>
        <div className="dc-setting-row"><div><p>{t('director.surface.browserNotification')}</p><small>{t('director.surface.permissionHint')}</small></div>{toggle(t('director.surface.browserNotification'), notifications, () => void requestNotification())}</div>
        <div className="dc-setting-row"><div><p>{t('director.surface.sound')}</p><small>{t('director.surface.soundHint')}</small></div>{toggle(t('director.surface.sound'), sound, () => setSound(!sound), !notifications)}</div>
      </section>
      {error && <p className="dc-settings-error" role="alert">{error}</p>}
      {advanced && <section><p className="dc-planning-hint">{t('director.execution.automaticBudgetHint')}</p><button type="button" onClick={onMethods}>{t('director.methods')}</button></section>}
      <footer><button type="button" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>{t('director.ui.advanced')}</button><button type="button" className="dc-primary-button" onClick={() => {
        const success = [saveDirectorPreference('notifications', notifications), saveDirectorPreference('sound', sound)].every(Boolean);
        if (!success) { setError(t('director.surface.storageError')); return; }
        onClose();
      }}>{t('director.ui.done')}</button></footer>
    </div>
  </div>;
}
