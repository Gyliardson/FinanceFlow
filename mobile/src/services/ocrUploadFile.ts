export type OcrUploadKind = 'image' | 'pdf';
export type SupportedOcrMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export interface OcrUploadAsset {
  uri: string;
  mimeType?: string | null;
  name?: string | null;
  fileName?: string | null;
}

export interface OcrUploadFile {
  uri: string;
  name: string;
  type: SupportedOcrMime;
}

const EXTENSION_BY_MIME: Record<SupportedOcrMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export const normalizeOcrMime = (value?: string | null): SupportedOcrMime | null => {
  const normalized = value?.split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  if (normalized === 'image/png') return 'image/png';
  if (normalized === 'image/webp') return 'image/webp';
  if (normalized === 'application/pdf') return 'application/pdf';
  return null;
};

export const inferOcrMimeFromPath = (value?: string | null): SupportedOcrMime | null => {
  if (!value) return null;
  const clean = value.split(/[?#]/, 1)[0].toLowerCase();
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.pdf')) return 'application/pdf';
  return null;
};

export const buildOcrUploadFile = (asset: OcrUploadAsset, kind: OcrUploadKind): OcrUploadFile | null => {
  if (!asset?.uri) return null;

  if (kind === 'pdf') {
    return {
      uri: asset.uri,
      name: 'documento.pdf',
      type: 'application/pdf',
    };
  }

  const mimeType = normalizeOcrMime(asset.mimeType)
    || inferOcrMimeFromPath(asset.fileName)
    || inferOcrMimeFromPath(asset.name)
    || inferOcrMimeFromPath(asset.uri);

  if (!mimeType || mimeType === 'application/pdf') return null;

  return {
    uri: asset.uri,
    name: `documento.${EXTENSION_BY_MIME[mimeType]}`,
    type: mimeType,
  };
};
