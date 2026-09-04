import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Asset } from '../lib/types.js';
import { UNCATEGORIZED } from '../lib/types.js';
import { api, apiDownload } from '../lib/api.js';
import { useCategories } from '../components/CategorySelect.js';
import { useT } from '../lib/i18n/index.js';
import { AssetCard } from '../components/AssetCard.js';

const MAX_SELECTION = 100;
const BLOCKED_DELETE_STATUSES = new Set(['queued', 'processing']);
type BulkDeleteResponse = { acceptedIds: string[]; rejected: Array<{ id: string; code: string }>; queuedForReconciliation: boolean };

function newIdempotencyKey() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function VideosPage() {
  const navigate = useNavigate();
  const { categories } = useCategories();
  const { t } = useT();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [exporting, setExporting] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteSuccess, setDeleteSuccess] = useState('');
  const query = categoryId ? `?categoryId=${encodeURIComponent(categoryId)}` : '';

  const refresh = useCallback(async () => {
    try { setAssets(await api<Asset[]>(`/v1/assets${query}`)); } catch { /* retain stale data while polling */ }
    finally { setLoading(false); }
  }, [query]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const exportCsv = useCallback(async () => {
    setExporting('');
    try { await apiDownload(`/v1/assets/export.csv${query}`, 'videos.csv'); }
    catch (error) { setExporting(error instanceof Error ? error.message : t.common.somethingWentWrong); }
  }, [query, t]);

  const filtered = useMemo(() => search ? assets.filter((asset) => asset.title.toLowerCase().includes(search.toLowerCase())) : assets, [assets, search]);
  const selectableVisible = filtered.filter((asset) => !BLOCKED_DELETE_STATUSES.has(asset.status));
  const selectedAssets = assets.filter((asset) => selectedIds.has(asset.id));
  const needsTypedConfirmation = selectedIds.size > 10;

  const toggleSelected = (asset: Asset, checked: boolean) => {
    if (BLOCKED_DELETE_STATUSES.has(asset.status)) return;
    setDeleteError('');
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) {
        if (next.size >= MAX_SELECTION) { setDeleteError(t.videos.selectionLimit); return previous; }
        next.add(asset.id);
      } else next.delete(asset.id);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const asset of selectableVisible) { if (next.size < MAX_SELECTION) next.add(asset.id); }
      if (selectableVisible.some((asset) => !next.has(asset.id))) setDeleteError(t.videos.selectionLimit);
      return next;
    });
  };

  const leaveSelectionMode = () => {
    setSelectionMode(false); setSelectedIds(new Set()); setDeleteError(''); setDeleteSuccess('');
  };

  const requestDeletion = async () => {
    if (!selectedIds.size || (needsTypedConfirmation && confirmation !== 'DELETE')) return;
    setDeleting(true); setDeleteError('');
    try {
      const result = await api<BulkDeleteResponse>('/v1/assets/bulk-delete', {
        method: 'POST', body: JSON.stringify({ assetIds: [...selectedIds], idempotencyKey: newIdempotencyKey() }),
      });
      const accepted = new Set(result.acceptedIds);
      setAssets((previous) => previous.filter((asset) => !accepted.has(asset.id)));
      setSelectedIds((previous) => new Set([...previous].filter((id) => !accepted.has(id))));
      setConfirmOpen(false); setConfirmation('');
      if (accepted.size) setDeleteSuccess(`${t.videos.deletionScheduled}: ${accepted.size}`);
      if (result.rejected.length) setDeleteError(`${result.rejected.length} ${t.videos.cannotDeleteProcessing}`);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t.videos.deletionFailed);
    } finally { setDeleting(false); }
  };

  return <>
    <div className="flex items-center justify-between mb-8">
      <div><h1 className="text-lg font-semibold text-zinc-50">{t.videos.title}</h1><p className="text-sm text-zinc-500 mt-1">{t.videos.subtitle}</p></div>
      <button onClick={() => navigate('/videos/new')} className="flex items-center gap-2 h-9 px-4 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500"><span aria-hidden="true">+</span>{t.videos.newVideo}</button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
      <h2 className="text-base font-semibold flex items-center gap-2">{t.videos.assets}<span className="text-xs font-medium text-zinc-500 bg-zinc-900 border border-zinc-800 px-2.5 py-0.5 rounded-full">{filtered.length}</span></h2>
      <div className="flex flex-wrap items-center gap-2">
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label={t.categories.category} className="h-9 px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 outline-none focus:border-accent-500/60"><option value="">{t.categories.all}</option><option value={UNCATEGORIZED}>{t.categories.uncategorized}</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
        <button onClick={() => void exportCsv()} disabled={!assets.length} title={t.categories.exportHint} className="h-9 px-3 text-sm font-medium rounded-lg border border-zinc-800 text-zinc-300 disabled:opacity-40">{t.categories.exportCsv}</button>
        <input type="text" placeholder={t.videos.search} value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t.videos.searchAssets} className="h-9 w-56 max-w-full px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 outline-none focus:border-accent-500/60" />
        {selectionMode ? <button onClick={leaveSelectionMode} className="h-9 px-3 text-sm font-medium rounded-lg border border-zinc-800 text-zinc-300">{t.common.cancel}</button> : <button onClick={() => setSelectionMode(true)} disabled={!selectableVisible.length} className="h-9 px-3 text-sm font-medium rounded-lg border border-zinc-800 text-zinc-300 disabled:opacity-40">{t.videos.select}</button>}
      </div>
    </div>
    {selectionMode && <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm"><span className="font-medium text-zinc-200">{selectedIds.size} {t.videos.selected}</span><button onClick={selectAllVisible} className="text-accent-400 hover:text-accent-300">{t.videos.selectAllVisible}</button><button onClick={() => setSelectedIds(new Set())} disabled={!selectedIds.size} className="text-zinc-400 disabled:opacity-40">{t.common.dismiss}</button><button onClick={() => { setConfirmOpen(true); setDeleteError(''); }} disabled={!selectedIds.size} className="ml-auto h-8 rounded-md bg-red-600 px-3 text-sm font-medium text-white disabled:opacity-40">{t.videos.deleteVideos} ({selectedIds.size})</button></div>}
    {(exporting || deleteError) && <p className="mb-3 text-xs text-red-400" role="alert">{exporting || deleteError}</p>}{deleteSuccess && <p className="mb-3 text-xs text-emerald-400" role="status">{deleteSuccess}</p>}
    {loading ? <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4" aria-label={t.common.loading}>{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-52 animate-pulse rounded-xl bg-zinc-900" />)}</div>
      : filtered.length === 0 ? <div className="py-20 text-center"><p className="text-sm text-zinc-400">{assets.length ? t.videos.noMatchingVideos : t.videos.noVideos}</p><p className="text-xs text-zinc-600 mt-1">{assets.length ? <button onClick={() => { setSearch(''); setCategoryId(''); }} className="text-accent-400">{t.videos.clearFilters}</button> : t.videos.noVideosHint}</p></div>
      : <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">{filtered.map((asset) => <AssetCard key={asset.id} asset={asset} onClick={() => navigate(`/videos/${asset.id}`)} selectionMode={selectionMode} selected={selectedIds.has(asset.id)} onSelect={(checked) => toggleSelected(asset, checked)} selectionDisabled={BLOCKED_DELETE_STATUSES.has(asset.status)} selectionDisabledLabel={t.videos.cannotDeleteProcessing} />)}</div>}
    {confirmOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) setConfirmOpen(false); }}><div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title"><h2 id="bulk-delete-title" className="text-base font-semibold text-zinc-50">{t.videos.deleteVideosTitle}</h2><p className="mt-2 text-sm text-zinc-300">{selectedIds.size} {t.videos.selected}</p><p className="mt-2 text-sm text-red-300">{t.videos.deleteVideosWarning}</p><ul className="mt-3 list-disc pl-5 text-xs text-zinc-500">{selectedAssets.slice(0, 3).map((asset) => <li key={asset.id} className="truncate">{asset.title}</li>)}{selectedAssets.length > 3 && <li>+{selectedAssets.length - 3}</li>}</ul>{needsTypedConfirmation && <label className="mt-4 block text-sm text-zinc-300">{t.videos.typeDeleteToConfirm}<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoFocus className="mt-2 h-9 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-accent-500" /></label>}<div className="mt-5 flex justify-end gap-2"><button disabled={deleting} onClick={() => setConfirmOpen(false)} className="h-9 rounded-lg px-3 text-sm text-zinc-300 disabled:opacity-40">{t.common.cancel}</button><button autoFocus={!needsTypedConfirmation} disabled={deleting || (needsTypedConfirmation && confirmation !== 'DELETE')} onClick={() => void requestDeletion()} className="h-9 rounded-lg bg-red-600 px-3 text-sm font-medium text-white disabled:opacity-40">{deleting ? t.common.deleting : `${t.videos.deleteVideos} (${selectedIds.size})`}</button></div></div></div>}
  </>;
}
