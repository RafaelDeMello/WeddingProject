/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" → API toda simulada; "photos" → só o upload simulado. */
  readonly VITE_MOCK_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
