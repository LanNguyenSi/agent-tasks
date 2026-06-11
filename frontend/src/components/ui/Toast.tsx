"use client";

// Portal-rendered toast stack (top-right).
// Tones: success / error / info.
// role=status for info/success, role=alert for error.
// Auto-dismiss at 5s with pause-on-hover. Dismiss button.
// Geometry in .toast-* classes in globals.css.
//
// Setup (once, in root layout):
//   <ToastProvider>{children}</ToastProvider>
//
// Usage in any client component:
//   const { toast } = useToast();
//   toast("Saved!", "success");

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

export type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

const AUTO_DISMISS_MS = 5000;

const TONE_CLASS: Record<ToastTone, string> = {
  success: "toast--success",
  error: "toast--error",
  info: "toast--info",
};

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep stable refs so the timer callback captures the latest values
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const idRef = useRef(item.id);

  const startTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(
      () => onDismissRef.current(idRef.current),
      AUTO_DISMISS_MS,
    );
  }, []);

  const pauseTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    startTimer();
    return pauseTimer;
  }, [startTimer, pauseTimer]);

  return (
    <div
      className={["toast", TONE_CLASS[item.tone]].join(" ")}
      role={item.tone === "error" ? "alert" : "status"}
      onMouseEnter={pauseTimer}
      onMouseLeave={startTimer}
    >
      <span className="toast-message">{item.message}</span>
      <button
        type="button"
        className="toast-dismiss"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const addToast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setItems((prev) => [...prev, { id, message, tone }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {mounted &&
        createPortal(
          <div className="toast-stack" aria-live="polite" aria-atomic="false">
            {items.map((item) => (
              <ToastCard key={item.id} item={item} onDismiss={dismiss} />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}
