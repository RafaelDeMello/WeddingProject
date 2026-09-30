/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" → API toda simulada; "photos" → só o upload simulado. Só vale no `vite dev`. */
  readonly VITE_MOCK_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
