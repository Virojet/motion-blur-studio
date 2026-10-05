export type OutputFps = 30 | 60 | 120;
export interface BlurSettings {
  strength: number; // Normalized to 60 FPS; engine amount = strength * outputFps / 60.
  outputFps: OutputFps;
  interpolate: boolean;
  interpolationMultiplier: number;
  interpolationMethod: 'svp' | 'rife';
  weighting: 'equal' | 'gaussian_sym' | 'pyramid' | 'vegas';
  deduplicate: boolean;
  quality: number;
  gpuInterpolation: boolean;
  gpuDecoding: boolean;
  gpuEncoding: boolean;
}
export const DEFAULT_SETTINGS: BlurSettings = {
  strength: 0.5, outputFps: 60, interpolate: true, interpolationMultiplier: 5,
  interpolationMethod: 'svp', weighting: 'equal', deduplicate: true, quality: 18,
  gpuInterpolation: true, gpuDecoding: false, gpuEncoding: false,
};
export interface Preferences { settings: BlurSettings; outputDirectory: string | null; engineDirectory: string | null }
export interface EngineStatus { ready: boolean; directory: string | null; blurPath: string | null; ffmpegPath: string | null; ffprobePath: string | null; issues: string[] }
export interface Clip {
  id: string; path: string; name: string; duration: number; width: number; height: number;
  fps: number; hasAudio: boolean; mediaUrl: string; error?: string;
}
export interface AppState { preferences: Preferences; engine: EngineStatus }
export type JobStatus = 'queued' | 'preparing' | 'rendering' | 'validating' | 'completed' | 'failed' | 'cancelled';
export interface JobUpdate { id: string; clipId: string; kind: 'preview' | 'export'; status: JobStatus; progress: number | null; message: string; log?: string; outputPath?: string }
export interface PreviewResult { clipId: string; originalUrl: string; processedUrl: string; start: number; duration: number; settingsKey: string }
export type AppEvent = { type: 'job'; job: JobUpdate } | { type: 'preview'; preview: PreviewResult } | { type: 'busy'; busy: boolean };
export interface MotionBlurAPI {
  getState(): Promise<AppState>;
  pickClips(): Promise<Clip[]>;
  inspectClips(paths: string[]): Promise<Clip[]>;
  getPathForFile(file: File): string;
  updatePreferences(preferences: Partial<Preferences>): Promise<Preferences>;
  selectEngine(): Promise<EngineStatus>;
  recheckEngine(): Promise<EngineStatus>;
  pickOutputFolder(): Promise<string | null>;
  renderPreview(clipId: string, start: number, settings: BlurSettings): Promise<void>;
  startExport(clipIds: string[], settings: BlurSettings, outputDirectory: string | null): Promise<void>;
  cancelWork(): Promise<void>;
  openOutput(path: string): Promise<void>;
  openBlurDownload(): Promise<void>;
  copyText(text: string): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
declare global { interface Window { motionBlur: MotionBlurAPI } }
