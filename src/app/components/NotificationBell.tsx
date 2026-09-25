import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { getActionErrorMessage, getNotifications, getRuntimeSettings, markNotificationRead } from '../api';
import type { AppNotification } from '../types';

export function NotificationBell() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'loading' | 'success' | 'error'; message: string } | null>(null);
  const readingRef = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = () => getNotifications().then((data) => { if (active) { setItems(data); setFeedback(null); } }).catch((error) => { if (active) setFeedback({ kind: 'error', message: getActionErrorMessage(error, 'Unable to load notifications.') }); });
    const start = async () => {
      const settings = await getRuntimeSettings().catch(() => ({ notificationPollingSeconds: 30 }));
      if (!active) return;
      load();
      timer = window.setInterval(load, Math.max(10, settings.notificationPollingSeconds) * 1000);
    };
    void start();
    return () => { active = false; if (timer !== undefined) window.clearInterval(timer); };
  }, []);

  const unread = items.filter((item) => !item.read).length;
  const read = async (item: AppNotification) => {
    if (item.read || readingRef.current.has(item.id)) return;
    readingRef.current.add(item.id);
    setFeedback({ kind: 'loading', message: `Marking “${item.title}” as read...` });
    try {
      await markNotificationRead(item.id);
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry));
      setFeedback({ kind: 'success', message: 'Notification marked as read.' });
    } catch (error) {
      setFeedback({ kind: 'error', message: getActionErrorMessage(error, 'Unable to mark the notification as read.') });
    } finally { readingRef.current.delete(item.id); }
  };

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-label={`Notifications, ${unread} unread`} className="relative rounded-lg p-2 text-gray-600 hover:bg-gray-100">
        <Bell size={22} />
        {unread > 0 && <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-600 px-1 text-center text-xs leading-5 text-white">{unread}</span>}
      </button>
      {open && <div className="absolute right-0 z-50 mt-2 max-h-96 w-80 overflow-auto rounded-lg border border-gray-200 bg-white shadow-xl">
        <div className="border-b px-4 py-3 font-medium">Notifications</div>
        {feedback && <div role={feedback.kind === 'error' ? 'alert' : 'status'} aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'} className={`border-b px-4 py-2 text-xs ${feedback.kind === 'error' ? 'bg-red-50 text-red-800' : feedback.kind === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-blue-50 text-blue-800'}`}>{feedback.message}</div>}
        {items.length === 0 ? <p className="p-4 text-sm text-gray-500">No notifications yet.</p> : items.map((item) => (
          <button key={item.id} type="button" onClick={() => read(item)} className={`block w-full border-b px-4 py-3 text-left hover:bg-gray-50 ${item.read ? 'bg-white' : 'bg-blue-50'}`}>
            <p className="text-sm font-medium text-gray-900">{item.title}</p>
            <p className="mt-1 text-xs text-gray-600">{item.message}</p>
            <p className="mt-1 text-xs text-gray-400">{new Date(item.createdAt).toLocaleString()}</p>
          </button>
        ))}
      </div>}
    </div>
  );
}
