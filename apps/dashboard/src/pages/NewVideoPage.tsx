import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n/index.js';
import type { AiOptions, Asset, ServerConfig } from '../lib/types.js';
import { CategorySelect, useCategories } from '../components/CategorySelect.js';

type SourceTab = 'upload' | 'import';
type ImportPhase = 'idle' | 'creating' | 'importing' | 'processing' | 'error';
type UploadStatus = 'pending' | 'creating' | 'uploading' | 'confirming' | 'processing' | 'queued' | 'ready' | 'error';
type RetryStage = 'upload' | 'processing';

interface UploadItem {
  localId: string;
  file?: File;
  fileName: string;
  fileSize: number;
  title: string;
  status: UploadStatus;
  progress: number;
  assetId?: string;
  error?: string;
  retryStage?: RetryStage;
}

interface RecoveryPointer {
  localId: string;
  assetId: string;
  fileName: string;
  fileSize: number;
  title: string;
}

interface UploadUrlResponse { uploadUrl: string; }

const BULK_UPLOAD_CONCURRENCY = 3;
const MAX_FILES_PER_BATCH = 100;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const RECOVERY_STORAGE_KEY = 'hovod-bulk-upload-recovery-v1';
const SUPPORTED_UPLOAD_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/mpeg',
  'video/ogg',
]);

function fileTitle(file: File) {
  return file.name.replace(/\.[^/.]+$/, '') || file.name;
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isActiveUpload(status: UploadStatus) {
  return ['creating', 'uploading', 'confirming', 'processing'].includes(status);
}

export function NewVideoPage() {
  const { categories, error: categoriesError, setCategories } = useCategories();
  const navigate = useNavigate();
  const { t } = useT();
  const [sourceTab, setSourceTab] = useState<SourceTab>('upload');
  const [items, setItems] = useState<UploadItem[]>([]);
  const [batchStarted, setBatchStarted] = useState(false);
  const [selectionErrors, setSelectionErrors] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [aiOptions, setAiOptions] = useState<AiOptions>({ transcription: true, subtitles: true, chapters: true });
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [importTitle, setImportTitle] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importPhase, setImportPhase] = useState<ImportPhase>('idle');
  const [importError, setImportError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<UploadItem[]>([]);
  const activeAiOptionsRef = useRef(aiOptions);
  const activeCategoryRef = useRef(categoryId);

  const replaceItems = useCallback((next: UploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patchItem = useCallback((localId: string, patch: Partial<UploadItem>) => {
    replaceItems(itemsRef.current.map((item) => item.localId === localId ? { ...item, ...patch } : item));
  }, [replaceItems]);

  useEffect(() => { api<ServerConfig>('/v1/config').then(setConfig).catch(() => {}); }, []);

  // Recovery data only points to server-owned assets; it never represents upload state.
  useEffect(() => {
    let cancelled = false;
    let pointers: RecoveryPointer[] = [];
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(RECOVERY_STORAGE_KEY) || '[]');
      if (Array.isArray(parsed)) pointers = parsed.filter((value): value is RecoveryPointer => (
        typeof value === 'object' && value !== null
        && typeof value.localId === 'string' && typeof value.assetId === 'string'
        && typeof value.title === 'string' && typeof value.fileName === 'string' && typeof value.fileSize === 'number'
      ));
    } catch { /* Ignore malformed browser-only recovery data. */ }

    replaceItems(pointers.map((pointer) => ({ ...pointer, status: 'processing', progress: 0 })));
    setRecoveryLoaded(true);
    void Promise.all(pointers.map(async (pointer) => {
      try {
        const asset = await api<Asset>(`/v1/assets/${pointer.assetId}`);
        if (cancelled) return;
        const status = asset.status.toLowerCase();
        if (status === 'queued') patchItem(pointer.localId, { status: 'queued', error: undefined, retryStage: undefined });
        else if (status === 'processing') patchItem(pointer.localId, { status: 'processing', error: undefined, retryStage: undefined });
        else if (status === 'ready') patchItem(pointer.localId, { status: 'ready', error: undefined, retryStage: undefined });
        else if (status === 'uploaded') patchItem(pointer.localId, { status: 'error', error: t.videos.uploadRecovered, retryStage: 'processing' });
        else if (status === 'error' || status === 'failed') patchItem(pointer.localId, { status: 'error', error: asset.errorMessage || t.videoDetail.transcodingFailed, retryStage: 'processing' });
        else patchItem(pointer.localId, { status: 'error', error: t.videos.selectFileToResume, retryStage: 'upload' });
      } catch {
        if (!cancelled) patchItem(pointer.localId, { status: 'error', error: t.common.somethingWentWrong, retryStage: 'processing' });
      }
    }));
    return () => { cancelled = true; };
  }, [patchItem, replaceItems, t]);

  useEffect(() => {
    if (!recoveryLoaded) return;
    const pointers: RecoveryPointer[] = items.filter((item) => item.assetId && item.status !== 'ready').slice(-MAX_FILES_PER_BATCH).map((item) => ({
      localId: item.localId, assetId: item.assetId!, title: item.title, fileName: item.fileName, fileSize: item.fileSize,
    }));
    localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(pointers));
  }, [items, recoveryLoaded]);

  const uploadFile = useCallback((file: File, uploadUrl: string, onProgress: (value: number) => void) => new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onload = () => xhr.status < 400 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Network error while uploading the file'));
    xhr.onabort = () => reject(new Error('Upload was cancelled'));
    xhr.send(file);
  }), []);

  const processAsset = useCallback(async (localId: string, assetId: string, useRetryEndpoint: boolean) => {
    patchItem(localId, { status: 'processing', progress: 100, error: undefined, retryStage: undefined });
    const body = config?.aiAvailable ? { aiOptions: activeAiOptionsRef.current } : undefined;
    await api(useRetryEndpoint ? `/v1/assets/${assetId}/retry` : `/v1/assets/${assetId}/process`, {
      method: 'POST', body: body ? JSON.stringify(body) : undefined,
    });
    patchItem(localId, { status: 'queued', progress: 100, error: undefined, retryStage: undefined });
  }, [config, patchItem]);

  const runUpload = useCallback(async (localId: string) => {
    const initial = itemsRef.current.find((item) => item.localId === localId);
    if (!initial?.file) {
      patchItem(localId, { status: 'error', error: t.videos.selectFileToResume, retryStage: 'upload' });
      return;
    }
    let assetId = initial.assetId;
    try {
      if (!assetId) {
        patchItem(localId, { status: 'creating', error: undefined, retryStage: undefined, progress: 0 });
        const created = await api<{ id: string }>('/v1/assets', {
          method: 'POST',
          body: JSON.stringify({
            title: initial.title.trim() || fileTitle(initial.file),
            ...(activeCategoryRef.current ? { categoryId: activeCategoryRef.current } : {}),
          }),
        });
        assetId = created.id;
        patchItem(localId, { assetId });
      }
      patchItem(localId, { status: 'uploading', progress: 0, error: undefined, retryStage: undefined });
      const { uploadUrl } = await api<UploadUrlResponse>(`/v1/assets/${assetId}/upload-url`, {
        method: 'POST', body: JSON.stringify({ contentType: initial.file.type || 'video/mp4' }),
      });
      await uploadFile(initial.file, uploadUrl, (progress) => patchItem(localId, { progress }));
      patchItem(localId, { status: 'confirming', progress: 100 });
      await api(`/v1/assets/${assetId}/upload-complete`, { method: 'POST' });
      await processAsset(localId, assetId, false);
    } catch (error) {
      const current = itemsRef.current.find((item) => item.localId === localId);
      const retryStage: RetryStage = current?.status === 'processing' || current?.status === 'confirming' ? 'processing' : 'upload';
      patchItem(localId, { status: 'error', error: error instanceof Error ? error.message : t.common.somethingWentWrong, retryStage });
    }
  }, [patchItem, processAsset, t, uploadFile]);

  const pumpQueue = useCallback(() => {
    const available = BULK_UPLOAD_CONCURRENCY - itemsRef.current.filter((item) => isActiveUpload(item.status)).length;
    if (available <= 0) return;
    const pending = itemsRef.current.filter((item) => item.status === 'pending' && item.file).slice(0, available);
    for (const item of pending) {
      patchItem(item.localId, { status: 'creating', error: undefined, retryStage: undefined });
      void runUpload(item.localId);
    }
  }, [patchItem, runUpload]);

  useEffect(() => { if (batchStarted) pumpQueue(); }, [batchStarted, items, pumpQueue]);

  const addFiles = useCallback((files: File[]) => {
    const next = [...itemsRef.current];
    const seen = new Set(next.filter((item) => item.file).map((item) => `${item.fileName}:${item.fileSize}`));
    const errors: string[] = [];
    const valid: UploadItem[] = [];
    for (const file of files) {
      const fingerprint = `${file.name}:${file.size}`;
      const recoveryIndex = next.findIndex((item) => !item.file && item.status === 'error' && item.retryStage === 'upload'
        && item.fileName === file.name && item.fileSize === file.size);
      if (!SUPPORTED_UPLOAD_CONTENT_TYPES.has(file.type.toLowerCase())) errors.push(`${file.name}: ${t.videos.unsupportedFile}`);
      else if (file.size > MAX_FILE_SIZE_BYTES) errors.push(`${file.name}: ${t.videos.fileTooLarge}`);
      else if (recoveryIndex >= 0) {
        next[recoveryIndex] = { ...next[recoveryIndex], file, status: 'pending', progress: 0, error: undefined, retryStage: undefined };
        seen.add(fingerprint);
      }
      else if (seen.has(fingerprint)) errors.push(`${file.name}: ${t.videos.duplicateFile}`);
      else if (next.filter((item) => item.file).length + valid.length >= MAX_FILES_PER_BATCH) errors.push(t.videos.batchFileLimit);
      else {
        seen.add(fingerprint);
        valid.push({ localId: crypto.randomUUID(), file, fileName: file.name, fileSize: file.size, title: fileTitle(file), status: 'pending', progress: 0 });
      }
    }
    if (valid.length || next.some((item, index) => item !== itemsRef.current[index])) replaceItems([...next, ...valid]);
    setSelectionErrors(errors);
  }, [replaceItems, t]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    if (!batchStarted) addFiles(Array.from(event.dataTransfer.files));
  }, [addFiles, batchStarted]);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (!batchStarted) addFiles(Array.from(event.target.files || []));
    event.target.value = '';
  }, [addFiles, batchStarted]);

  const startUploadBatch = useCallback(() => {
    if (batchStarted || !itemsRef.current.some((item) => item.status === 'pending' && item.file)) return;
    activeAiOptionsRef.current = aiOptions;
    activeCategoryRef.current = categoryId;
    setBatchStarted(true);
  }, [aiOptions, batchStarted, categoryId]);

  const retryItem = useCallback(async (item: UploadItem) => {
    if (item.retryStage === 'upload') {
      if (!item.file) return;
      patchItem(item.localId, { status: 'creating', error: undefined, retryStage: undefined, progress: 0 });
      void runUpload(item.localId);
      return;
    }
    if (!item.assetId) return;
    try {
      const asset = await api<Asset>(`/v1/assets/${item.assetId}`);
      const status = asset.status.toLowerCase();
      if (status === 'created') {
        if (!item.file) {
          patchItem(item.localId, { status: 'error', error: t.videos.selectFileToResume, retryStage: 'upload' });
          return;
        }
        patchItem(item.localId, { status: 'creating', error: undefined, retryStage: undefined, progress: 0 });
        void runUpload(item.localId);
        return;
      }
      await processAsset(item.localId, item.assetId, status === 'error' || status === 'failed');
    } catch (error) {
      patchItem(item.localId, { status: 'error', error: error instanceof Error ? error.message : t.common.somethingWentWrong, retryStage: 'processing' });
    }
  }, [patchItem, processAsset, runUpload, t]);

  const startImport = useCallback(async () => {
    if (!importUrl || (importPhase !== 'idle' && importPhase !== 'error')) return;
    setImportError('');
    try {
      setImportPhase('creating');
      const created = await api<{ id: string }>('/v1/assets', { method: 'POST', body: JSON.stringify({ title: importTitle.trim() || 'Imported video', ...(categoryId ? { categoryId } : {}) }) });
      setImportPhase('importing');
      await api(`/v1/assets/${created.id}/import`, { method: 'POST', body: JSON.stringify({ sourceUrl: importUrl }) });
      setImportPhase('processing');
      const body = config?.aiAvailable ? { aiOptions } : undefined;
      await api(`/v1/assets/${created.id}/process`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      navigate(`/videos/${created.id}`);
    } catch (error) {
      setImportPhase('error');
      setImportError(error instanceof Error ? error.message : t.common.somethingWentWrong);
    }
  }, [aiOptions, categoryId, config, importPhase, importTitle, importUrl, navigate, t]);

  const isUploadBusy = items.some((item) => isActiveUpload(item.status));
  const hasPendingUploads = items.some((item) => item.status === 'pending' && item.file);
  const completedUploads = items.filter((item) => item.status === 'queued' || item.status === 'ready').length;
  const hasActiveBatch = batchStarted && (isUploadBusy || hasPendingUploads || items.some((item) => item.status === 'error'));
  const importWorking = importPhase !== 'idle' && importPhase !== 'error';

  return (
    <>
      <div className="mb-8 flex items-center gap-4">
        <button onClick={() => navigate('/videos')} className="flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          {t.nav.videos}
        </button>
        <h1 className="text-lg font-semibold text-zinc-50">{t.videos.newVideo}</h1>
      </div>

      <div className="max-w-3xl">
        <div className="mb-6">
          <label className="block text-xs font-medium text-zinc-400 mb-2">{t.videos.source}</label>
          <div className="flex gap-1 mb-3 p-1 bg-zinc-900 rounded-lg w-fit">
            <button onClick={() => !isUploadBusy && setSourceTab('upload')} disabled={isUploadBusy} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${sourceTab === 'upload' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>{t.videos.uploadFile}</button>
            <button onClick={() => !isUploadBusy && setSourceTab('import')} disabled={isUploadBusy} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${sourceTab === 'import' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}>{t.videos.importUrl}</button>
          </div>

          {sourceTab === 'upload' ? <>
            <div role="button" tabIndex={batchStarted ? -1 : 0} aria-label={t.videos.uploadVideo} aria-disabled={batchStarted}
              className={`border-2 border-dashed rounded-xl py-9 px-6 text-center transition-all ${batchStarted ? 'pointer-events-none opacity-50' : 'cursor-pointer'} ${dragOver ? 'border-accent-500 bg-accent-500/5' : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/40'}`}
              onDragOver={(event) => { if (!batchStarted) { event.preventDefault(); setDragOver(true); } }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
              onClick={() => !batchStarted && inputRef.current?.click()} onKeyDown={(event) => { if (!batchStarted && (event.key === 'Enter' || event.key === ' ')) inputRef.current?.click(); }}>
              <input ref={inputRef} type="file" accept="video/*" multiple hidden onChange={onFileChange} />
              <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10 14V3M10 3l4 4M10 3L6 7" /><path d="M3 14v2a1 1 0 001 1h12a1 1 0 001-1v-2" /></svg></div>
              <p className="text-sm text-zinc-400">{t.videos.dragDropMultiple}</p><p className="text-xs text-zinc-600 mt-1">{t.videos.bulkFileLimits}</p>
            </div>
            {selectionErrors.length > 0 && <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20" role="alert">{selectionErrors.map((error, index) => <p key={`${error}-${index}`} className="text-xs text-red-400">{error}</p>)}</div>}
            {items.length > 0 && <div className="mt-5">
              <div className="flex items-center justify-between mb-2"><h2 className="text-sm font-medium text-zinc-200">{items.length} {t.videos.filesSelected}</h2>{completedUploads > 0 && <span className="text-xs text-zinc-500">{completedUploads} {t.videoDetail.queued.toLowerCase()}</span>}</div>
              <ul className="space-y-2" aria-label={t.videos.selectedFiles}>
                {items.map((item) => {
                  const working = isActiveUpload(item.status);
                  const canRetry = item.status === 'error' && (item.retryStage === 'processing' || Boolean(item.file));
                  const label = item.status === 'creating' ? t.common.creating : item.status === 'uploading' ? `${t.common.uploading} ${item.progress}%` : item.status === 'confirming' ? t.videos.verifyingUpload : item.status === 'processing' ? t.videos.startingTranscoding : item.status === 'queued' ? t.videoDetail.queuedForTranscoding : item.status === 'ready' ? t.videoDetail.ready : item.status === 'error' ? t.videoDetail.failed : t.videos.waitingToUpload;
                  return <li key={item.localId} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                    <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><input aria-label={`${t.videoSettings.titleLabel}: ${item.fileName}`} value={item.title} disabled={working || batchStarted || item.status === 'queued' || item.status === 'ready'} onChange={(event) => patchItem(item.localId, { title: event.target.value })} className="w-full bg-transparent text-sm font-medium text-zinc-200 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed disabled:opacity-100" /><p className="mt-0.5 truncate text-xs text-zinc-500" title={item.fileName}>{item.fileName} · {formatBytes(item.fileSize)}</p></div>
                      <div className="flex shrink-0 items-center gap-2">{item.assetId && (item.status === 'queued' || item.status === 'ready') && <button onClick={() => navigate(`/videos/${item.assetId}`)} className="text-xs text-accent-400 hover:text-accent-300">{t.videos.viewVideo}</button>}{canRetry && <button onClick={() => void retryItem(item)} className="text-xs text-accent-400 hover:text-accent-300">{item.retryStage === 'processing' ? t.videos.retryProcessing : t.videos.retryUpload}</button>}{!batchStarted && !working && <button onClick={() => replaceItems(itemsRef.current.filter((candidate) => candidate.localId !== item.localId))} className="text-xs text-zinc-500 hover:text-zinc-300">{t.common.remove}</button>}</div></div>
                    {(working || item.status === 'queued' || item.status === 'ready' || item.status === 'error') && <div className="mt-2"><div className="flex justify-between gap-3 text-xs"><span className={item.status === 'error' ? 'text-red-400' : 'text-zinc-400'}>{item.error || label}</span>{item.status === 'uploading' && <span className="text-zinc-500">{item.progress}%</span>}</div>{item.status === 'uploading' && <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-label={`${t.common.uploading}: ${item.fileName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}><div className="h-full rounded-full bg-accent-500 transition-[width] duration-300" style={{ width: `${item.progress}%` }} /></div>}</div>}
                  </li>;
                })}
              </ul>
            </div>}
            {items.some((item) => item.status === 'error' && item.retryStage === 'upload' && !item.file) && <p className="mt-3 text-xs text-amber-400">{t.videos.selectFileToResume}</p>}
          </> : <div className="space-y-4"><input type="text" placeholder={t.videos.urlPlaceholder} value={importUrl} onChange={(event) => setImportUrl(event.target.value)} disabled={importWorking} className="w-full h-10 px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors disabled:opacity-50" /><input type="text" placeholder={t.videos.enterTitle} value={importTitle} onChange={(event) => setImportTitle(event.target.value)} disabled={importWorking} className="w-full h-10 px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60 transition-colors disabled:opacity-50" /></div>}
        </div>

        <div className="mb-6">
          <label className="block text-xs font-medium text-zinc-400 mb-3">{t.categories.category}</label>
          <CategorySelect
            value={categoryId}
            onChange={setCategoryId}
            categories={categories}
            onCreated={(created) => setCategories((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))}
            disabled={batchStarted || importWorking}
          />
          {categoriesError && <p className="mt-1 text-xs text-amber-400">{t.categories.loadFailed}</p>}
        </div>

        {config?.aiAvailable && <div className="mb-6"><label className="block text-xs font-medium text-zinc-400 mb-3">{t.videos.aiProcessing}</label><div className="space-y-3"><Toggle label={t.videos.subtitles} description={t.videos.subtitlesDesc} checked={aiOptions.subtitles} onChange={(value) => setAiOptions({ ...aiOptions, subtitles: value, transcription: value || aiOptions.chapters })} disabled={batchStarted || importWorking} />{config.chaptersAvailable && <Toggle label={t.videos.chapters} description={t.videos.chaptersDesc} checked={aiOptions.chapters} onChange={(value) => setAiOptions({ ...aiOptions, chapters: value, transcription: value || aiOptions.subtitles })} disabled={batchStarted || importWorking} />}</div></div>}
        {sourceTab === 'import' && importError && <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20" role="alert"><p className="text-xs text-red-400">{importError}</p></div>}
        {sourceTab === 'upload' ? <div className="flex items-center gap-3"><button onClick={startUploadBatch} disabled={batchStarted || !hasPendingUploads} className="h-10 px-5 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">{t.videos.startProcessing}</button>{!hasActiveBatch && batchStarted && <button onClick={() => { replaceItems([]); setBatchStarted(false); setSelectionErrors([]); }} className="h-10 px-4 text-sm font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 transition-colors">{t.videos.startNewBatch}</button>}</div> : <button onClick={() => void startImport()} disabled={!importUrl || importWorking} className="h-10 px-5 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">{importWorking ? t.videos.importing : t.videos.startProcessing}</button>}
      </div>
    </>
  );
}

function Toggle({ label, description, checked, onChange, disabled = false }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className={`flex items-center justify-between gap-4 p-3 rounded-lg border transition-colors cursor-pointer ${disabled ? 'border-zinc-800/50 opacity-50 cursor-not-allowed' : checked ? 'border-zinc-800 bg-zinc-900/60' : 'border-zinc-800/50 hover:border-zinc-700'}`}><div className="min-w-0"><p className="text-sm text-zinc-200">{label}</p><p className="text-xs text-zinc-500 mt-0.5">{description}</p></div><button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={(event) => { event.preventDefault(); if (!disabled) onChange(!checked); }} className={`relative shrink-0 w-9 h-5 rounded-full transition-colors ${checked ? 'bg-accent-600' : 'bg-zinc-700'}`}><span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} /></button></label>;
}
