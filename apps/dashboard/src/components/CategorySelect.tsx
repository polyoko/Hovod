import { useCallback, useEffect, useState } from 'react';
import type { Category } from '../lib/types.js';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n/index.js';

const SELECT_CLASS = 'h-9 px-3 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 outline-none focus:border-accent-500/60 transition-colors';

/** Shared category list. Every consumer refetches on mount — the list is tiny and rarely stale. */
export function useCategories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setCategories(await api<Category[]>('/v1/categories'));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { categories, error, refresh, setCategories };
}

interface Props {
  value: string | null;
  onChange: (categoryId: string | null) => void;
  categories: Category[];
  onCreated?: (category: Category) => void;
  disabled?: boolean;
  className?: string;
}

/** Category picker with inline creation, so a batch upload never has to leave the page. */
export function CategorySelect({ value, onChange, categories, onCreated, disabled, className }: Props) {
  const { t } = useT();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const created = await api<Category>('/v1/categories', {
        method: 'POST', body: JSON.stringify({ name: trimmed }),
      });
      onCreated?.(created);
      onChange(created.id);
      setName('');
      setCreating(false);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.somethingWentWrong);
    } finally {
      setBusy(false);
    }
  }

  if (creating) {
    return (
      <div className={className}>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); create(); }
              if (e.key === 'Escape') { setCreating(false); setError(''); }
            }}
            placeholder={t.categories.namePlaceholder}
            aria-label={t.categories.namePlaceholder}
            maxLength={100}
            className={`${SELECT_CLASS} flex-1 placeholder-zinc-600`}
          />
          <button type="button" onClick={create} disabled={busy || !name.trim()}
            className="h-9 px-3 text-sm font-medium rounded-lg bg-accent-600 text-white hover:bg-accent-500 disabled:opacity-40 transition-colors">
            {busy ? t.common.creating : t.common.create}
          </button>
          <button type="button" onClick={() => { setCreating(false); setError(''); }}
            className="h-9 px-3 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
            {t.common.cancel}
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        aria-label={t.categories.category}
        className={`${SELECT_CLASS} flex-1 disabled:opacity-40`}
      >
        <option value="">{t.categories.none}</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button type="button" onClick={() => setCreating(true)} disabled={disabled}
        className="h-9 px-3 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-800 rounded-lg disabled:opacity-40 transition-colors">
        + {t.categories.newCategory}
      </button>
    </div>
  );
}
