export type ActionFeedbackState = {
  kind: 'loading' | 'success' | 'error' | 'info';
  message: string;
};

const styles = {
  loading: 'border-blue-200 bg-blue-50 text-blue-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-red-200 bg-red-50 text-red-900',
  info: 'border-slate-200 bg-slate-50 text-slate-800',
};

export function ActionFeedback({ feedback, className = '' }: { feedback: ActionFeedbackState | null; className?: string }) {
  if (!feedback) return null;
  return (
    <div
      role={feedback.kind === 'error' ? 'alert' : 'status'}
      aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`rounded-md border px-4 py-3 text-sm ${styles[feedback.kind]} ${className}`}
    >
      {feedback.kind === 'loading' && <span aria-hidden="true" className="mr-2 inline-block size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />}
      {feedback.message}
    </div>
  );
}
