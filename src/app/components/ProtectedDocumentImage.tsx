import { useEffect, useState } from 'react';
import { getProtectedDocumentObjectUrl } from '../api';
import { ImageWithFallback } from './ImageWithFallback';

export function ProtectedDocumentImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let loadedUrl: string | null = null;
    void getProtectedDocumentObjectUrl(src)
      .then((url) => {
        loadedUrl = url;
        if (active) setObjectUrl(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (active) setObjectUrl(null);
      });
    return () => {
      active = false;
      if (loadedUrl) URL.revokeObjectURL(loadedUrl);
    };
  }, [src]);

  if (!objectUrl) {
    return (
      <div
        className={`${className || ''} grid place-items-center bg-slate-100 text-[11px] text-slate-500`}
        role="img"
        aria-label={alt}
      >
        Protected document
      </div>
    );
  }
  return <ImageWithFallback src={objectUrl} alt={alt} className={className} />;
}
