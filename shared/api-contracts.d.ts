export type AccountRole = 'admin' | 'user';
export type SectionKey = 'films' | 'series' | 'music' | 'books' | 'comics' | 'manga';
export type ReadingCategory = 'books' | 'comics' | 'manga';

export interface ApiErrorPayload {
  error: string;
  code?: string;
  section?: SectionKey;
}

export interface Account {
  id: string;
  username: string;
  accountKey?: string;
  role: AccountRole;
  enabled?: boolean;
  mustChangePassword?: boolean;
  passwordConfigured?: boolean;
  sections?: SectionKey[];
}

export interface Device {
  id: string;
  deviceName?: string;
  fingerprint: string;
  installationId?: string;
  pairedAt?: string;
  revokedAt?: string | null;
}

export interface MovieSummary {
  id: number;
  title: string;
  year?: number | null;
  posterUrl?: string | null;
  streamUrl?: string;
}

export interface SeriesSummary {
  seriesUuid: string;
  title: string;
  year?: number | null;
  posterUrl?: string | null;
}

export interface ReadingSummary {
  id: number;
  category: ReadingCategory;
  title: string;
  coverUrl?: string | null;
  fileUrl?: string;
}

export interface MusicTrack {
  trackUuid: string;
  title: string;
  streamUrl: string;
  albumUuid?: string;
  artists?: string[];
}

export interface PairingRedeemRequest {
  inviteToken: string;
  installationId: string;
  publicKey: string;
  signature: string;
  deviceName?: string;
}

export interface PairingStatus {
  paired: boolean;
  currentServerMatches: boolean;
  serverBaseUrl: string | null;
  deviceId: string | null;
  deviceName: string | null;
  fingerprint: string | null;
  pairedAt: string | null;
  suggestedDeviceName: string;
}

export type UploadRole = 'movie-video' | 'series-videos' | 'music-audio' | 'poster' | 'reading-document';

export interface NativeUploadSelection {
  token: string;
  role: UploadRole;
  name: string;
  size: number;
  previewDataUrl: string | null;
}

export interface NativeUploadProgress {
  phase: 'uploading' | 'processing' | 'failed';
  loaded: number;
  total: number;
}

export interface ApiTransportRequest {
  path: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE';
  headers: Record<string, string>;
  body: string | null;
}

export interface ApiTransportResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

export interface CoreBootstrap {
  coreVersion: string;
  platform: string;
  apiBaseUrl: string;
  transport: string;
  installationId: string;
}

export function isRecord(value: unknown): value is Record<string, unknown>;
export function isRelativeApiPath(value: unknown): value is string;
export function isPairingRedeemRequest(value: unknown): value is PairingRedeemRequest;
export function parseApiError(value: unknown): ApiErrorPayload | null;
export function parseApiTransportResponse(value: unknown): ApiTransportResponse;
export function parseCoreBootstrap(value: unknown): CoreBootstrap;
export function parsePairingStatus(value: unknown): PairingStatus;
