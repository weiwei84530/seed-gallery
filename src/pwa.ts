import { useEffect, useRef, useState } from 'react';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isIos =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSafari =
  isIos &&
  /Safari/.test(navigator.userAgent) &&
  !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);

export function usePwa() {
  const [standalone, setStandalone] = useState(
    window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in navigator &&
        (navigator as Navigator & { standalone?: boolean }).standalone === true),
  );
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [updateBlocked, setUpdateBlocked] = useState(false);
  const reloadOnChange = useRef(false);

  useEffect(() => {
    const display = window.matchMedia('(display-mode: standalone)');
    const changed = () =>
      setStandalone(
        display.matches ||
          ('standalone' in navigator &&
            (navigator as Navigator & { standalone?: boolean }).standalone === true),
      );
    display.addEventListener('change', changed);
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const installed = () => {
      setInstallPrompt(null);
      setStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', installed);
    return () => {
      display.removeEventListener('change', changed);
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let live = true;
    let registration: ServiceWorkerRegistration | undefined;
    const changed = () => {
      if (reloadOnChange.current) location.reload();
    };
    const message = (event: MessageEvent) => {
      if (event.data === 'UPDATE_OTHER_TABS') {
        reloadOnChange.current = false;
        setUpdateBlocked(true);
      }
    };
    const updateFound = () => {
      const installing = registration?.installing;
      installing?.addEventListener('statechange', () => {
        if (live && installing.state === 'installed' && navigator.serviceWorker.controller)
          setWaiting(registration?.waiting ?? null);
      });
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
    };
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    navigator.serviceWorker.addEventListener('message', message);
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' })
      .then((result) => {
        if (!live) return;
        registration = result;
        setWaiting(result.waiting);
        result.addEventListener('updatefound', updateFound);
        if (result.installing) updateFound();
        visible();
      })
      .catch(() => {});
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(visible, 60 * 60 * 1000);
    return () => {
      live = false;
      registration?.removeEventListener('updatefound', updateFound);
      navigator.serviceWorker.removeEventListener('controllerchange', changed);
      navigator.serviceWorker.removeEventListener('message', message);
      document.removeEventListener('visibilitychange', visible);
      window.clearInterval(timer);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    setInstallPrompt(null);
    await prompt.prompt();
    await prompt.userChoice;
  };
  const applyUpdate = () => {
    if (!waiting) return;
    setUpdateBlocked(false);
    reloadOnChange.current = true;
    waiting.postMessage('SKIP_WAITING');
  };
  return {
    standalone,
    isIos,
    isSafari,
    canInstall: Boolean(installPrompt) && !standalone,
    install,
    waiting: Boolean(waiting),
    updateBlocked,
    applyUpdate,
  };
}
