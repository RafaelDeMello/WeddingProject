import { useEffect, useState } from 'react';

interface Props {
  photo: Blob;
  onSend(): void;
  onRetake(): void;
}

export function PhotoPreview({ photo, onSend, onRetake }: Props) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(photo);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo]);

  return (
    <section className="preview">
      {url && <img src={url} alt="Prévia da foto" />}
      <div className="preview-actions">
        <button type="button" className="secondary" onClick={onRetake}>
          Tirar outra
        </button>
        <button type="button" className="primary" onClick={onSend}>
          Enviar
        </button>
      </div>
    </section>
  );
}
