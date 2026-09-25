import { toast } from 'sonner';

export const showToast = {
  success: (message: string) => {
    toast.success(message, {
      duration: 3000,
      style: {
        background: '#10b981',
        color: '#fff',
        border: 'none',
      },
    });
  },
  error: (message: string) => {
    toast.error(message, {
      duration: 3000,
      style: {
        background: '#ef4444',
        color: '#fff',
        border: 'none',
      },
    });
  },
  info: (message: string) => {
    toast.info(message, {
      duration: 3000,
      style: {
        background: '#3b82f6',
        color: '#fff',
        border: 'none',
      },
    });
  },
  warning: (message: string) => {
    toast.warning(message, {
      duration: 3000,
      style: {
        background: '#f59e0b',
        color: '#fff',
        border: 'none',
      },
    });
  },
};
