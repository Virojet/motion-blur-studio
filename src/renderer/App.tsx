import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode, type SyntheticEvent } from 'react';
import { DEFAULT_SETTINGS, type BlurSettings, type Clip, type EngineStatus, type JobUpdate, type Preferences, type PreviewResult } from '../shared/types';

type IconName = 'add' | 'arrow' | 'check' | 'chevron' | 'close' | 'copy' | 'download' | 'film' | 'folder' | 'info' | 'pause' | 'play' | 'refresh' | 'settings' | 'spark' | 'stop' | 'warning';
function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    add: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></>,
    film: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" /></>,
    folder: <path d="M3 7V5h7l2 3h9v12H3V7Z" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v.2" /></>,
    pause: <><path d="M8 5v14M16 5v14" strokeWidth="3" /></>,
    play: <path d="m8 4 12 8-12 8V4Z" />,
    refresh: <><path d="M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5L20 2Z" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    warning: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.2" /></>,
  };
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const PRESETS = [{ name: 'Light', strength: 0.25, text: 'A subtle touch' }, { name: 'Balanced', strength: 0.5, text: 'Smooth & natural' }, { name: 'Strong', strength: 1, text: 'Cinematic trails' }];
const ACTIVE_STATUSES = new Set(['queued', 'preparing', 'rendering', 'validating']);
function seconds(value: number) { const safe = Number.isFinite(value) ? Math.max(0, value) : 0; return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`; }
function preciseSeconds(value: number) { return `${Math.max(0, Number.isFinite(value) ? value : 0).toFixed(1)}s`; }
function settingsKey(settings: BlurSettings) { return JSON.stringify(settings); }
function progressPercent(value: number) { return Math.round(Math.max(0, Math.min(1, value)) * 100); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error); }
function Toggle({ label, detail, checked, onChange, disabled = false }: { label: string; detail?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <label className={`toggle-row ${disabled ? 'is-disabled' : ''}`}><span><span className="toggle-label">{label}</span>{detail && <span className="toggle-detail">{detail}</span>}</span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} disabled={disabled} /><span className="toggle-track" aria-hidden="true" /></label>;
}

function Player({ clip, preview, stale }: { clip: Clip; preview: PreviewResult | undefined; stale: boolean }) {
  const original = useRef<HTMLVideoElement>(null);
  const processed = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<'compare' | 'original' | 'blurred'>('compare');
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(preview?.duration ?? clip.duration);
  const [divider, setDivider] = useState(50);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const playAttempt = useRef(0);
  const originalUrl = preview?.originalUrl ?? clip.mediaUrl;

  useEffect(() => { setPlaying(false); setTime(0); setMediaError(null); setDuration(preview?.duration ?? clip.duration); setMode(preview ? 'compare' : 'original'); }, [originalUrl, preview?.processedUrl, clip.id, clip.duration, preview?.duration]);
  useEffect(() => {
    const a = original.current, b = processed.current;
    return () => { playAttempt.current++; a?.pause(); b?.pause(); };
  }, []);
  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const sync = () => {
      const a = original.current, b = processed.current;
      if (a) {
        setTime(a.currentTime);
        if (b && Math.abs(b.currentTime - a.currentTime) > 0.08) b.currentTime = a.currentTime;
      }
      frame = requestAnimationFrame(sync);
    };
    frame = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const isCurrentSource = (video: HTMLVideoElement, expected: string, reference: HTMLVideoElement | null) => video === reference && video.getAttribute('src') === expected;
  const pause = () => { playAttempt.current++; original.current?.pause(); processed.current?.pause(); setPlaying(false); setStarting(false); };
  const handleMediaError = (event: SyntheticEvent<HTMLVideoElement>, kind: 'original' | 'processed') => {
    const video = event.currentTarget;
    const expected = kind === 'original' ? originalUrl : preview?.processedUrl;
    if (!expected || !isCurrentSource(video, expected, kind === 'original' ? original.current : processed.current)) return;
    pause();
    const details = video.error ? ` (player code ${video.error.code}${video.error.message ? `: ${video.error.message}` : ''})` : '';
    setMediaError(!preview && kind === 'original'
      ? `Your clip is imported, but this format cannot play here. Generate a preview for a compatible sample.${details}`
      : `The ${kind === 'original' ? 'before' : 'blurred'} preview could not play. Reload playback or generate the preview again.${details}`);
  };
  const playPause = async () => {
    if (playing || starting) { pause(); return; }
    const a = original.current, b = processed.current;
    if (!a) return;
    const attempt = ++playAttempt.current;
    setStarting(true);
    if (a.ended || a.currentTime >= duration - 0.03) { a.currentTime = 0; if (b) b.currentTime = 0; }
    try {
      await Promise.all([a.play(), ...(b ? [b.play()] : [])]);
      if (attempt !== playAttempt.current || a !== original.current || b !== processed.current) return;
      setStarting(false); setPlaying(true);
    } catch (error) {
      if (attempt !== playAttempt.current || a !== original.current || b !== processed.current) return;
      pause();
      // A pause or source replacement can abort play(); it does not mean a codec failed.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMediaError(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Playback was blocked. Reload playback, then press Play again.'
        : preview ? 'The preview could not start. Reload playback or generate the preview again.' : 'This format cannot play in the built-in player. Generate a preview to create a compatible sample.');
    }
  };
  const seek = (value: number) => { if (original.current) original.current.currentTime = value; if (processed.current) processed.current.currentTime = value; setTime(value); };
  const reloadPlayback = () => { pause(); setMediaError(null); setTime(0); original.current?.load(); processed.current?.load(); };

  return <div className="player-card">
    <div className="player-toolbar"><div className="segmented view-switch" aria-label="Preview view">{(['compare', 'original', 'blurred'] as const).map(value => <button key={value} className={mode === value ? 'active' : ''} onClick={() => setMode(value)} disabled={value !== 'original' && !preview}>{value === 'compare' ? 'Compare' : value === 'original' ? 'Original' : 'Blurred'}</button>)}</div><span className={`player-status ${stale && preview ? 'stale' : ''}`}><span className="tiny-dot" />{preview ? stale ? 'Preview out of date' : 'Preview ready' : 'Original clip'}</span></div>
    <div className={`video-stage ${preview ? 'has-preview' : ''}`}>
      <video ref={original} key={originalUrl} src={originalUrl} className="original-video" preload="metadata" muted={muted} onLoadedMetadata={event => { if (!isCurrentSource(event.currentTarget, originalUrl, original.current)) return; const actual = event.currentTarget.duration; if (actual && Number.isFinite(actual)) setDuration(actual); }} onTimeUpdate={event => { if (isCurrentSource(event.currentTarget, originalUrl, original.current)) setTime(event.currentTarget.currentTime); }} onEnded={event => { if (isCurrentSource(event.currentTarget, originalUrl, original.current)) pause(); }} onError={event => handleMediaError(event, 'original')} />
      {preview && <video ref={processed} key={preview.processedUrl} src={preview.processedUrl} className="processed-video" preload="auto" muted style={{ clipPath: mode === 'compare' ? `inset(0 0 0 ${divider}%)` : mode === 'original' ? 'inset(0 100% 0 0)' : undefined }} onError={event => handleMediaError(event, 'processed')} />}
      <div className="video-labels"><span>{mode === 'blurred' ? 'WITH MOTION BLUR' : 'ORIGINAL'}</span>{preview && mode === 'compare' && <span>WITH MOTION BLUR</span>}</div>
      {preview && mode === 'compare' && <><div className="compare-divider" style={{ left: `${divider}%` }}><span>‹ ›</span></div><input className="compare-input" type="range" min="0" max="100" value={divider} aria-label="Before and after comparison position" onChange={event => setDivider(Number(event.target.value))} /></>}
      {!playing && !starting && !mediaError && mode !== 'compare' && <button className="big-play" onClick={() => void playPause()} aria-label="Play clip"><Icon name="play" size={28} /></button>}
      {mediaError && <div className="media-error"><Icon name="film" size={32} /><p>{mediaError}</p><button className="secondary-button" onClick={reloadPlayback}><Icon name="refresh" size={14} />Reload playback</button></div>}
    </div>
    <div className="transport"><button className="icon-button" aria-label={playing || starting ? 'Pause' : 'Play'} onClick={() => void playPause()} disabled={!!mediaError}><Icon name={playing || starting ? 'pause' : 'play'} size={16} /></button><span className="time-readout">{seconds(time)}</span><input type="range" className="playhead" min="0" max={duration || 1} step="0.01" value={Math.min(time, duration || 1)} onChange={event => seek(Number(event.target.value))} aria-label="Playback position" disabled={!!mediaError} /><span className="time-readout duration">{seconds(duration)}</span><button className={`sound-button ${muted ? 'muted' : ''}`} onClick={() => setMuted(value => !value)} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute audio' : 'Mute audio'}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9h4l5-4v14l-5-4H4V9Z" />{muted ? <path d="m17 9 5 6m0-6-5 6" /> : <><path d="M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14" /></>}</svg></button></div>
    <div className="player-footnote"><Icon name="info" size={13} /><span>{preview ? 'Drag the divider to compare. Both views play in sync.' : 'Generate a 3-second preview to see your blur settings.'}</span></div>
  </div>;
}

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [settings, setSettings] = useState<BlurSettings>({ ...DEFAULT_SETTINGS });
  const [outputDirectory, setOutputDirectory] = useState<string | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobUpdate>>({});
  const [previewJob, setPreviewJob] = useState<JobUpdate | null>(null);
  const [previews, setPreviews] = useState<Record<string, PreviewResult>>({});
  const [starts, setStarts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [importing, setImporting] = useState(false);
  const [engineChecking, setEngineChecking] = useState(false);
  const [enginePanel, setEnginePanel] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const savedPreferences = useRef('');
  const dragDepth = useRef(0);
  const bridge = window.motionBlur;
  const selected = clips.find(clip => clip.id === selectedId) ?? null;
  const preview = selected ? previews[selected.id] : undefined;
  const playerKey = `${selected?.id ?? ''}:${preview?.originalUrl ?? selected?.mediaUrl ?? ''}:${preview?.processedUrl ?? ''}`;
  const selectedPreviewJob = previewJob?.clipId === selectedId ? previewJob : null;
  const previewStart = selected ? Math.min(starts[selected.id] ?? 0, Math.max(0, selected.duration - 3)) : 0;
  const stale = !!preview && (preview.settingsKey !== settingsKey(settings) || Math.abs(preview.start - previewStart) > 0.05);
  const selectedJob = selected ? jobs[selected.id] : undefined;
  const validClips = clips.filter(clip => !clip.error);
  const activeJobs = Object.values(jobs).filter(job => ACTIVE_STATUSES.has(job.status));
  const currentJob = activeJobs.find(job => job.status !== 'queued') ?? activeJobs[0] ?? (previewJob && ACTIVE_STATUSES.has(previewJob.status) ? previewJob : null);
  const completedJobs = Object.values(jobs).filter(job => job.status === 'completed');
  const failedJobs = Object.values(jobs).filter(job => job.status === 'failed');
  const totalDuration = clips.reduce((sum, clip) => sum + (clip.duration || 0), 0);
  const allLogs = [...Object.values(jobs), ...(previewJob ? [previewJob] : [])].filter(job => job.log || job.status === 'failed').map(job => `${job.kind.toUpperCase()} · ${clips.find(clip => clip.id === job.clipId)?.name ?? job.clipId}\n${job.message}\n${job.log ?? ''}`).join('\n\n');

  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!bridge) { setLoaded(true); notify('Open Blur Studio as a desktop app to import and process clips.', true); return; }
    let alive = true;
    bridge.getState().then(state => {
      if (!alive) return;
      savedPreferences.current = JSON.stringify({ settings: state.preferences.settings, outputDirectory: state.preferences.outputDirectory });
      setSettings(state.preferences.settings); setOutputDirectory(state.preferences.outputDirectory); setEngine(state.engine); setLoaded(true);
    }).catch(error => { if (alive) { setLoaded(true); notify(errorMessage(error), true); } });
    const unsubscribe = bridge.onEvent(event => {
      if (event.type === 'busy') { setBusy(event.busy); if (!event.busy) setCancelling(false); }
      if (event.type === 'preview') { setPreviews(previous => ({ ...previous, [event.preview.clipId]: event.preview })); notify('Preview ready. Press play to compare.'); }
      if (event.type === 'job') {
        const merge = (previous: JobUpdate | undefined): JobUpdate => ({ ...event.job, log: `${previous?.id === event.job.id ? previous.log ?? '' : ''}${event.job.log ?? ''}`.slice(-100000) });
        if (event.job.kind === 'preview') setPreviewJob(previous => merge(previous ?? undefined));
        else setJobs(previous => ({ ...previous, [event.job.clipId]: merge(previous[event.job.clipId]) }));
        if (event.job.status === 'failed') notify(event.job.message, true);
      }
    });
    return () => { alive = false; unsubscribe(); };
  }, [bridge, notify]);

  useEffect(() => {
    if (!loaded || !bridge) return;
    const preferences: Partial<Preferences> = { settings, outputDirectory };
    const key = JSON.stringify(preferences);
    if (key === savedPreferences.current) return;
    const timer = setTimeout(() => { bridge.updatePreferences(preferences).then(() => { savedPreferences.current = key; }).catch(error => notify(`Could not save settings: ${errorMessage(error)}`, true)); }, 350);
    return () => clearTimeout(timer);
  }, [settings, outputDirectory, loaded, bridge, notify]);

  useEffect(() => {
    if (!enginePanel && !logsOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>('.modal');
    const focusables = () => Array.from(modal?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setEnginePanel(false); setLogsOpen(false); }
      if (event.key !== 'Tab') return;
      const items = focusables(), first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previouslyFocused?.focus(); };
  }, [enginePanel, logsOpen]);

  const change = <K extends keyof BlurSettings>(key: K, value: BlurSettings[K]) => setSettings(previous => ({ ...previous, [key]: value }));
  const addClips = (incoming: Clip[]) => {
    if (!incoming.length) return;
    const byPath = new Map(incoming.map(clip => [clip.path.toLowerCase(), clip]));
    setClips(previous => {
      const paths = new Set(previous.map(clip => clip.path.toLowerCase()));
      const updated = previous.map(clip => clip.error ? byPath.get(clip.path.toLowerCase()) ?? clip : clip);
      return [...updated, ...Array.from(byPath.values()).filter(clip => !paths.has(clip.path.toLowerCase()))];
    });
    setSelectedId(previous => {
      const current = clips.find(clip => clip.id === previous);
      return current?.error ? byPath.get(current.path.toLowerCase())?.id ?? previous : previous ?? incoming[0].id;
    });
    const failures = incoming.filter(clip => clip.error);
    if (failures.length) notify(failures.length === 1 ? failures[0].error! : `${failures.length} clips could not be inspected. Select a clip for details.`, true);
  };
  const importFiles = async (paths?: string[]) => {
    if (!bridge || busy || importing) return;
    setImporting(true);
    try { addClips(paths ? await bridge.inspectClips(paths) : await bridge.pickClips()); } catch (error) { notify(errorMessage(error), true); } finally { setImporting(false); }
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (!bridge || busy) return;
    try { const paths = Array.from(event.dataTransfer.files).map(file => bridge.getPathForFile(file)).filter(Boolean); if (paths.length) void importFiles(paths); } catch (error) { notify(errorMessage(error), true); }
  };
  const updateEngine = async (choose: boolean) => {
    if (!bridge) return;
    setEngineChecking(true);
    try { const next = await (choose ? bridge.selectEngine() : bridge.recheckEngine()); setEngine(next); if (next.ready) { setEnginePanel(false); notify('Blur engine connected. You’re ready to render.'); if (clips.some(clip => clip.error)) { const reinspected = await bridge.inspectClips(clips.map(clip => clip.path)); addClips(reinspected); } } } catch (error) { notify(errorMessage(error), true); } finally { setEngineChecking(false); }
  };
  const generatePreview = async () => {
    if (!bridge || !selected || busy || !engine?.ready || selected.error) return;
    setBusy(true); setPreviewJob(null);
    try { await bridge.renderPreview(selected.id, previewStart, { ...settings }); } catch (error) {
      const message = errorMessage(error);
      setBusy(false); setPreviewJob({ id: `preview-error-${Date.now()}`, clipId: selected.id, kind: 'preview', status: 'failed', progress: null, message }); notify(message, true);
    }
  };
  const exportClips = async (ids: string[]) => {
    if (!bridge || busy || !engine?.ready || !ids.length) return;
    setBusy(true); setPreviewJob(null);
    try { await bridge.startExport(ids, { ...settings }, outputDirectory); } catch (error) { setBusy(false); notify(errorMessage(error), true); }
  };
  const cancel = async () => {
    if (!bridge) return;
    setCancelling(true);
    try { await bridge.cancelWork(); } catch (error) { setCancelling(false); notify(errorMessage(error), true); }
  };
  const browseOutput = async () => { if (!bridge) return; try { const directory = await bridge.pickOutputFolder(); if (directory) setOutputDirectory(directory); } catch (error) { notify(errorMessage(error), true); } };
  const openOutput = async (path: string) => { try { await bridge?.openOutput(path); } catch (error) { notify(errorMessage(error), true); } };
  const download = async () => { try { await bridge?.openBlurDownload(); } catch (error) { notify(errorMessage(error), true); } };
  const removeClip = (id: string) => { if (busy) return; setClips(previous => previous.filter(clip => clip.id !== id)); if (selectedId === id) setSelectedId(clips.find(clip => clip.id !== id)?.id ?? null); setJobs(previous => { const next = { ...previous }; delete next[id]; return next; }); };
  const previewFailurePanel = selectedPreviewJob && ['failed', 'cancelled'].includes(selectedPreviewJob.status)
    ? <div className={`job-result result-${selectedPreviewJob.status} preview-failure`} role="status"><Icon name={selectedPreviewJob.status === 'failed' ? 'warning' : 'stop'} size={17} /><div><strong>{selectedPreviewJob.status === 'failed' ? 'Preview could not be generated.' : 'Preview cancelled.'}</strong><span title={selectedPreviewJob.message}>{selectedPreviewJob.message}</span></div><button className="text-button" onClick={() => setLogsOpen(true)}>View log <Icon name="info" size={13} /></button><button className="text-button" onClick={() => void generatePreview()} disabled={busy}>Retry <Icon name="refresh" size={13} /></button></div>
    : null;

  const setupContent = <div className="engine-setup"><div className="setup-icon"><Icon name="settings" size={26} /></div><div className="eyebrow">ONE-TIME SETUP</div><h2>Connect your Blur engine</h2><p>Blur Studio gives Tekno’s Blur a simpler home. Select the folder containing <code>blur-cli.exe</code> and its tools to get started.</p>{engine?.issues.length ? <div className="setup-issues">{engine.issues.map(issue => <div key={issue}><Icon name="warning" size={14} /><span>{issue}</span></div>)}</div> : null}<div className="setup-actions"><button className="primary-button" onClick={() => void updateEngine(true)} disabled={engineChecking || busy || !bridge}><Icon name="folder" />{engineChecking ? 'Checking…' : 'Locate Blur folder'}</button><button className="secondary-button" onClick={() => void updateEngine(false)} disabled={engineChecking || busy || !bridge}><Icon name="refresh" size={16} />Check again</button></div><button className="text-button download-link" onClick={() => void download()} disabled={!bridge}>Download Tekno’s Blur <Icon name="arrow" size={14} /></button><div className="setup-tip"><Icon name="info" size={15} /><span>An <code>.opdownload</code> file is still downloading. Finish the download and install Blur before selecting its folder.</span></div></div>;

  return <div className={`app ${dragging ? 'dragging' : ''}`} onDragEnter={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }} onDragLeave={event => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }} onDrop={onDrop}>
    <header className="topbar"><div className="brand"><div className="brand-mark"><span /><span /><span /><span /></div><span>blur<span className="brand-light">studio</span></span><span className="brand-divider" /><span className="brand-tagline">Make every frame flow.</span></div><div className="topbar-right"><span className="privacy-label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4" /></svg>100% local</span><button className={`engine-badge ${engine?.ready ? 'connected' : 'missing'}`} onClick={() => setEnginePanel(true)} title={engine?.directory ?? 'Configure Blur engine'}><span className="tiny-dot" />{!loaded ? 'Connecting…' : engine?.ready ? 'Engine connected' : 'Setup required'}<Icon name="chevron" size={12} /></button></div></header>
    <main className="workspace">
      <aside className="clip-panel"><div className="panel-heading"><h2>Your clips</h2><span className="count-badge">{clips.length.toString().padStart(2, '0')}</span></div><button className="add-clips" onClick={() => void importFiles()} disabled={importing || busy || !bridge}><Icon name="add" size={17} />{importing ? 'Importing clips…' : 'Add clips'}<kbd>＋</kbd></button><div className="clip-list" aria-label="Clip queue">{clips.length ? clips.map((clip, index) => { const job = jobs[clip.id]; return <div className={`clip-item ${selectedId === clip.id ? 'selected' : ''}`} key={clip.id}><button className="clip-select" onClick={() => setSelectedId(clip.id)} aria-pressed={selectedId === clip.id}><span className="clip-thumbnail"><Icon name="film" size={22} /><span>{String(index + 1).padStart(2, '0')}</span></span><span className="clip-copy"><span className="clip-name" title={clip.name}>{clip.name}</span><span className="clip-meta">{clip.error ? 'Could not read clip' : `${seconds(clip.duration)} · ${clip.height}p · ${Number(clip.fps.toFixed(2))} fps`}</span>{job && <span className={`clip-status status-${job.status}`}>{job.status === 'completed' && <Icon name="check" size={11} />}{job.status === 'failed' && <Icon name="warning" size={11} />}{job.status === 'queued' ? 'In queue' : job.status === 'completed' ? 'Exported' : job.status === 'cancelled' ? 'Cancelled' : job.status === 'failed' ? 'Export failed' : `${job.status.charAt(0).toUpperCase()}${job.status.slice(1)}${job.progress !== null ? ` · ${progressPercent(job.progress)}%` : ''}`}</span>}</span></button><button className="clip-remove" aria-label={`Remove ${clip.name}`} onClick={() => removeClip(clip.id)} disabled={busy}><Icon name="close" size={12} /></button></div>; }) : <div className="queue-empty"><Icon name="film" size={26} /><p>Your next smooth edit<br />starts here.</p><span>MP4, MOV, MKV & more</span></div>}</div><div className="queue-bottom">{clips.length > 0 && <div className="queue-summary"><span>{clips.length} {clips.length === 1 ? 'clip' : 'clips'}</span><span>{seconds(totalDuration)} total</span></div>}<div className="queue-note"><span className="queue-note-icon"><Icon name="info" size={14} /></span><p>Drop files anywhere.<br />We’ll keep the originals safe.</p></div><button className="engine-manage" onClick={() => setEnginePanel(true)}><Icon name="settings" size={15} /><span>Manage engine</span><Icon name="chevron" size={12} /></button></div></aside>
      <section className="preview-panel"><div className="preview-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h1 title={selected?.name}>{selected ? selected.name : 'A little blur. A lot smoother.'}</h1></div>{selected && !selected.error && <span className="resolution-badge">{selected.width} × {selected.height}</span>}</div>
        {!loaded ? <div className="center-loading"><span className="spinner" /><p>Connecting to your workspace…</p></div> : !engine?.ready ? setupContent : selected ? <><div className="selected-info"><span><Icon name="film" size={13} />{Number(selected.fps.toFixed(2))} fps source</span><span>{seconds(selected.duration)}</span><span>{selected.hasAudio ? 'Audio preserved' : 'No audio track'}</span></div>{selected.error ? <div className="clip-error"><Icon name="warning" size={32} /><h2>Couldn’t open this clip</h2><p>{selected.error}</p><button className="secondary-button" onClick={() => void importFiles([selected.path])} disabled={importing || busy}><Icon name="refresh" size={16} />Try importing again</button></div> : <><Player key={playerKey} clip={selected} preview={preview} stale={stale} />{previewFailurePanel}<div className="sample-card"><div className="sample-heading"><div><h3>Find your moment</h3><p>Preview a {preciseSeconds(Math.min(3, selected.duration))} sample before you export.</p></div><span className="sample-range">{preciseSeconds(previewStart)} <Icon name="arrow" size={12} /> {preciseSeconds(Math.min(selected.duration, previewStart + 3))}</span></div><div className="sample-controls"><span className="sample-min">0:00</span><div className="sample-slider"><input type="range" min="0" max={Math.max(0, selected.duration - 3)} step="0.1" value={previewStart} onChange={event => setStarts(previous => ({ ...previous, [selected.id]: Number(event.target.value) }))} disabled={busy || selected.duration <= 3} aria-label="Preview sample start time" /><span className="sample-track-fill" style={{ width: `${selected.duration > 3 ? (previewStart / (selected.duration - 3)) * 100 : 0}%` }} /></div><span className="sample-max">{seconds(selected.duration)}</span></div><button className="preview-button" onClick={() => void generatePreview()} disabled={busy || !engine.ready}><Icon name={busy && currentJob?.kind === 'preview' ? 'refresh' : 'spark'} size={17} className={busy && currentJob?.kind === 'preview' ? 'spinning' : ''} />{busy && currentJob?.kind === 'preview' ? 'Rendering preview…' : preview ? stale ? 'Update preview' : 'Generate again' : 'Generate preview'}</button></div></>}{selectedJob && <div className={`job-result result-${selectedJob.status}`}><Icon name={selectedJob.status === 'completed' ? 'check' : selectedJob.status === 'failed' ? 'warning' : selectedJob.status === 'cancelled' ? 'stop' : 'film'} size={17} /><div><strong>{selectedJob.status === 'completed' ? 'Your smooth clip is ready.' : selectedJob.status === 'failed' ? 'This clip needs another try.' : selectedJob.status === 'cancelled' ? 'Export cancelled.' : 'Export in progress'}</strong><span title={selectedJob.outputPath}>{selectedJob.status === 'completed' ? selectedJob.outputPath : selectedJob.message}</span></div>{selectedJob.status === 'completed' && selectedJob.outputPath && <button className="text-button" onClick={() => void openOutput(selectedJob.outputPath!)}>Open folder <Icon name="folder" size={14} /></button>}{selectedJob.status === 'failed' && <button className="text-button" disabled={busy} onClick={() => void exportClips([selectedJob.clipId])}>Retry <Icon name="refresh" size={14} /></button>}</div>}</> : <div className="welcome"><div className="motion-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><div className="motion-strip strip-one" /><div className="motion-strip strip-two" /><div className="motion-strip strip-three" /><div className="motion-core"><Icon name="play" size={36} /></div><span className="art-tiny-label art-label-one">BEFORE</span><span className="art-tiny-label art-label-two">AFTER</span><div className="art-spark spark-one" /><div className="art-spark spark-two" /></div><span className="eyebrow">LESS FRICTION. MORE FLOW.</span><h2>Give your clips<br /><span>a smoother finish.</span></h2><p>Drop in a clip, find your blur, and export.<br />The details? We’ve got them covered.</p><button className="primary-button welcome-add" onClick={() => void importFiles()} disabled={importing || busy}><Icon name="add" size={18} />Choose your first clip <Icon name="arrow" size={16} /></button><div className="welcome-steps"><span><b>01</b> Add clips</span><i /><span><b>02</b> Find your blur</span><i /><span><b>03</b> Export</span></div></div>}
        <div className="workspace-note"><Icon name="info" size={14} /><span>Exports use the full clip. Previewing a sample won’t trim your video.</span></div>
      </section>
      <aside className="settings-panel"><div className="panel-heading"><h2>Make it yours</h2><Icon name="settings" size={17} /></div><div className="settings-scroll"><section className="setting-section"><div className="setting-title"><h3>Blur style</h3><span className="tiny-label">START HERE</span></div><div className="preset-grid">{PRESETS.map(preset => <button key={preset.name} className={`preset ${Math.abs(settings.strength - preset.strength) < 0.001 ? 'active' : ''}`} onClick={() => change('strength', preset.strength)} aria-pressed={Math.abs(settings.strength - preset.strength) < 0.001}><span className={`preset-art preset-${preset.name.toLowerCase()}`} aria-hidden="true"><i /><i /><i /><i /></span><strong>{preset.name}</strong><span>{preset.text}</span>{Math.abs(settings.strength - preset.strength) < 0.001 && <span className="preset-check"><Icon name="check" size={9} /></span>}</button>)}</div><div className="slider-label"><label htmlFor="strength">Blur strength</label><span className="value-chip">{Number(settings.strength.toFixed(2))}×</span></div><input id="strength" className="setting-slider" type="range" min="0" max="2" step="0.05" value={settings.strength} onChange={event => change('strength', Number(event.target.value))} style={{ background: `linear-gradient(to right, var(--accent) ${settings.strength / 2 * 100}%, var(--track) ${settings.strength / 2 * 100}%)` }} /><div className="slider-caption"><span>Subtle</span><span>Dreamy</span></div></section>
        <section className="setting-section output-settings"><div className="setting-title"><h3>Output</h3><span className="tiny-label">MP4 · H.264</span></div><label className="field-label">Frame rate</label><div className="segmented fps-switch" aria-label="Output frame rate">{([30, 60, 120] as const).map(fps => <button className={settings.outputFps === fps ? 'active' : ''} key={fps} onClick={() => change('outputFps', fps)} aria-pressed={settings.outputFps === fps}>{fps}<span> fps</span></button>)}</div><div className="output-facts"><span><Icon name="check" size={12} />Original resolution</span><span><Icon name="check" size={12} />Source audio</span></div><label className="field-label output-folder-label">Save to</label><button className="output-folder" onClick={() => void browseOutput()} disabled={!bridge} title={outputDirectory ?? 'A Blurred folder beside each original clip'}><Icon name="folder" size={17} /><span><strong>{outputDirectory ? outputDirectory.split(/[\\/]/).filter(Boolean).pop() : 'Beside original clips'}</strong><small>{outputDirectory ?? 'In a “Blurred” folder'}</small></span><Icon name="chevron" size={13} /></button>{outputDirectory && <button className="folder-reset text-button" onClick={() => setOutputDirectory(null)}>Use folders beside originals</button>}</section>
        <section className={`setting-section advanced-section ${advanced ? 'expanded' : ''}`}><button className="advanced-toggle" onClick={() => setAdvanced(value => !value)} aria-expanded={advanced}><span><Icon name="settings" size={15} />Advanced settings</span><Icon name="chevron" size={14} /></button>{advanced && <div className="advanced-fields"><p className="advanced-help">Fine-tune the engine. Your choices apply to every clip in the queue.</p><Toggle label="Frame interpolation" detail="Create frames for smoother motion" checked={settings.interpolate} onChange={value => change('interpolate', value)} /><div className={`advanced-group ${!settings.interpolate ? 'is-disabled' : ''}`}><label className="field-label" htmlFor="method">Interpolation method</label><select id="method" value={settings.interpolationMethod} onChange={event => change('interpolationMethod', event.target.value as BlurSettings['interpolationMethod'])} disabled={!settings.interpolate}><option value="svp">SVP · fast</option><option value="rife">RIFE · higher quality</option></select><div className="slider-label"><label htmlFor="multiplier">Interpolation multiplier</label><span>{settings.interpolationMultiplier}×</span></div><input id="multiplier" className="setting-slider" type="range" min="2" max="10" step="1" value={settings.interpolationMultiplier} onChange={event => change('interpolationMultiplier', Number(event.target.value))} disabled={!settings.interpolate} /><Toggle label="GPU interpolation" checked={settings.gpuInterpolation} onChange={value => change('gpuInterpolation', value)} disabled={!settings.interpolate} /></div><label className="field-label" htmlFor="weighting">Blur weighting</label><select id="weighting" value={settings.weighting} onChange={event => change('weighting', event.target.value as BlurSettings['weighting'])}><option value="equal">Equal · balanced blending</option><option value="gaussian_sym">Gaussian · soft trails</option><option value="pyramid">Pyramid · center weighted</option><option value="vegas">Vegas · classic blend</option></select><Toggle label="Remove duplicate frames" checked={settings.deduplicate} onChange={value => change('deduplicate', value)} /><div className="slider-label"><label htmlFor="quality">Encoding quality (CRF)</label><span>{settings.quality}</span></div><input id="quality" className="setting-slider" type="range" min="12" max="28" step="1" value={settings.quality} onChange={event => change('quality', Number(event.target.value))} /><div className="slider-caption"><span>Higher quality</span><span>Smaller files</span></div><Toggle label="GPU decoding" checked={settings.gpuDecoding} onChange={value => change('gpuDecoding', value)} /><Toggle label="GPU encoding" detail="Requires a supported graphics card" checked={settings.gpuEncoding} onChange={value => change('gpuEncoding', value)} /><p className="gpu-note">GPU options need compatible hardware and engine support. If rendering fails, try turning them off.</p><button className="text-button reset-settings" onClick={() => setSettings({ ...DEFAULT_SETTINGS })}><Icon name="refresh" size={13} />Reset to defaults</button></div>}</section>
      </div><div className="export-section">{busy ? <><div className="export-progress-label"><span>{currentJob?.kind === 'preview' ? 'Creating your preview' : currentJob ? 'Smoothing your clips' : 'Starting engine…'}</span><strong>{currentJob?.progress !== null && currentJob?.progress !== undefined ? `${progressPercent(currentJob.progress)}%` : 'Working'}</strong></div><div className={`export-progress ${currentJob?.progress === null ? 'indeterminate' : ''}`}><span style={{ width: `${currentJob?.progress != null ? progressPercent(currentJob.progress) : 35}%` }} /></div><p className="export-detail">{currentJob?.message ?? 'Preparing the processing queue'}</p><button className="cancel-button" onClick={() => void cancel()} disabled={cancelling}><Icon name="stop" size={14} />{cancelling ? 'Cancelling…' : 'Cancel processing'}</button></> : <><div className="export-ready"><span>{validClips.length ? `${validClips.length} ${validClips.length === 1 ? 'clip ready' : 'clips ready'}` : 'Your next great edit awaits'}</span><span>{settings.outputFps} fps</span></div><button className="export-button" onClick={() => void exportClips(validClips.map(clip => clip.id))} disabled={!engine?.ready || !validClips.length || importing}><Icon name="download" size={18} />{validClips.length > 1 ? `Export ${validClips.length} clips` : 'Export clip'}<Icon name="arrow" size={16} /></button>{failedJobs.length > 0 && <button className="retry-batch text-button" onClick={() => void exportClips(failedJobs.map(job => job.clipId))}>Retry {failedJobs.length} failed {failedJobs.length === 1 ? 'clip' : 'clips'} <Icon name="refresh" size={13} /></button>}<p className="export-caption">High quality. Full-length clips. All yours.</p></>}</div></aside>
    </main>
    <footer className="statusbar"><span><span className={`tiny-dot ${busy ? 'busy-dot' : ''}`} />{busy ? currentJob?.message ?? 'Processing locally…' : completedJobs.length > 0 ? `${completedJobs.length} ${completedJobs.length === 1 ? 'clip exported' : 'clips exported'} successfully` : 'Ready when you are'}</span><button onClick={() => setLogsOpen(true)} disabled={!allLogs && !Object.keys(jobs).length && !previewJob}><Icon name="info" size={13} />Processing log</button><span className="footer-credit">Powered by Tekno’s Blur</span></footer>
    {dragging && <div className="drop-overlay"><div><Icon name="add" size={42} /><h2>{busy ? 'Finish processing first' : 'Drop your clips here'}</h2><p>{busy ? 'You can add more clips after the current job.' : 'A smoother finish is just a drop away.'}</p></div></div>}
    {enginePanel && <div className="modal-overlay" onClick={() => setEnginePanel(false)}><section className="modal engine-modal" role="dialog" aria-modal="true" aria-labelledby="engine-dialog-title" onClick={event => event.stopPropagation()}><div className="modal-header"><h2 id="engine-dialog-title">Blur engine</h2><button className="icon-button" aria-label="Close engine setup" onClick={() => setEnginePanel(false)}><Icon name="close" /></button></div>{engine?.ready ? <div className="engine-connected"><div className="connected-symbol"><Icon name="check" size={24} /></div><h3>You’re connected.</h3><p>Blur CLI, FFmpeg, and FFprobe are ready.</p><code>{engine.directory}</code><div className="setup-actions"><button className="secondary-button" disabled={busy || engineChecking} onClick={() => void updateEngine(true)}><Icon name="folder" size={16} />Change folder</button><button className="secondary-button" disabled={busy || engineChecking} onClick={() => void updateEngine(false)}><Icon name="refresh" size={16} />{engineChecking ? 'Checking…' : 'Check again'}</button></div></div> : setupContent}</section></div>}
    {logsOpen && <div className="modal-overlay" onClick={() => setLogsOpen(false)}><section className="modal logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-dialog-title" onClick={event => event.stopPropagation()}><div className="modal-header"><h2 id="logs-dialog-title">Processing log</h2><div><button className="text-button" disabled={!allLogs} onClick={() => { void bridge?.copyText(allLogs).then(() => notify('Log copied to clipboard.')).catch(error => notify(errorMessage(error), true)); }}><Icon name="copy" size={14} />Copy</button><button className="icon-button" aria-label="Close processing log" onClick={() => setLogsOpen(false)}><Icon name="close" /></button></div></div><p className="logs-description">Details from the Blur engine. Copy these if you need help with a failed render.</p><pre>{allLogs || 'Waiting for the engine to report progress…'}</pre></section></div>}
    {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role={toast.error ? 'alert' : 'status'}><Icon name={toast.error ? 'warning' : 'check'} size={17} /><span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><Icon name="close" size={15} /></button></div>}
  </div>;
}
