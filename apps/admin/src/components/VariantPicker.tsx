import { useEffect, useState } from 'react';
import { api, type CatalogItem } from '@pos/lib/api';
import { formatMoney, formatQty } from '@pos/lib/format';
import { SearchInput } from '@pos/ui';

/**
 * Buscador de artículos para órdenes de compra, listas de precios y ajustes.
 * Busca igual que la caja: código de barras, SKU o nombre.
 */
export function VariantPicker({
  onPick,
  placeholder = 'Buscar artículo por nombre, SKU o código…',
  autoFocus,
}: {
  onPick: (item: CatalogItem) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!term.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setBusy(true);
      try {
        const response = await api.posSearch({ q: term, limit: 8 });
        if (!cancelled) setResults(response.data);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [term]);

  return (
    <div className="variant-picker">
      <SearchInput
        compact
        busy={busy}
        autoFocus={autoFocus}
        value={term}
        placeholder={placeholder}
        aria-label="Buscar artículo"
        onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && results[0]) {
            onPick(results[0]);
            setTerm('');
          }
        }}
      />
      {results.length > 0 && (
        <ul className="variant-picker__results">
          {results.map((item) => (
            <li key={item.variantId}>
              <button
                type="button"
                onClick={() => {
                  onPick(item);
                  setTerm('');
                }}
              >
                <span>
                  <strong>{item.name}</strong>
                  <span className="mono subtle text-sm"> {item.sku}</span>
                </span>
                <span className="subtle text-sm">
                  {formatMoney(item.unitPrice)} · {item.trackStock ? `${formatQty(item.qtyAvailable)} en existencia` : 'servicio'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
